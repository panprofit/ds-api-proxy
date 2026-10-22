'use strict';

const SESSION_EXPIRED_STATUSES = new Set([400, 404, 409, 410, 500]);

const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BASE_DELAY_MS = 300;

const { estimateTokens } = require('./openai');
const { truncateForLog, shortAgentId } = require('./http');
const config = require('./config');

function createUpstreamSession({
    getOrCreateAgentSession,
    prepareSessionForPrompt,
    resetRemoteSession,
    recordTokenRate,

    tokenRatePressure = (_session, _limitPerMin) => 0,
    selectAccountForSession,
    markAccountFailure,
    solvePowForPath,
    createRemoteSession,
    dsChatCompletionWithPow,
    createUpstreamHttpError,
    waitForCompletionSlot = null,
    refreshAccountToken = null,
    refreshClientHeaders = null,
    log = console.log,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {

    return async function askDSStream({
        prompt,
        agentId,
        freshSessionPrompt = prompt,
        fileIds = [],
        fileIdsAccountId = null,
        resolveFileIds = null,
        thinkingEnabled = undefined,
        searchEnabled = undefined,
        deadlineHit = () => false,
        clientGone = () => false,
    }) {
        const session = getOrCreateAgentSession(agentId);
        const hadRemoteSession = Boolean(session.id);
        const account = selectAccountForSession(session, { resetRemoteSession });
        const dsHeaders = account.headers;
        const agentTag = `[${shortAgentId(agentId)}/acct:${account.id}]`;

        const thinkingTag = thinkingEnabled ? ' (thinking)' : '';

        const rollover = prepareSessionForPrompt(session);
        const accountRotationReset = hadRemoteSession && !session.id;
        const recoveredFreshSession = accountRotationReset || Boolean(rollover);
        let effectivePrompt = recoveredFreshSession ? freshSessionPrompt : prompt;
        if (accountRotationReset) {
            log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
        }
        if (rollover) {
            log(`${agentTag} Session ${rollover.failedSessionId} reset before upstream call (${rollover.reason}).`);
        }

        if (waitForCompletionSlot) {

            const limitPerMin = config.get().tokenRateLimitPerMin;
            const pressure = limitPerMin > 0 ? tokenRatePressure(session, limitPerMin) : 0;
            const granted = await waitForCompletionSlot(account, { deadlineHit, clientGone, pressure });
            if (!granted) {

                throw createUpstreamHttpError(429, 'account completion throttle: no slot before the deadline');
            }
        }

        if (refreshAccountToken && !deadlineHit() && !clientGone()) {
            await refreshAccountToken(account);
        }

        if (refreshClientHeaders && !deadlineHit() && !clientGone()) {
            await refreshClientHeaders(dsHeaders);
        }

        let effectiveFileIds = fileIds;
        let effectiveFileIdsAccountId = fileIdsAccountId;
        if (resolveFileIds && fileIdsAccountId && account.id !== fileIdsAccountId) {
            const resolved = await resolveFileIds(account, { shouldAbort: () => clientGone() || deadlineHit() });
            if (Array.isArray(resolved)) {
                effectiveFileIds = resolved;
                effectiveFileIdsAccountId = account.id;
            }
        }

        if (!session.id) {
            session.id = await createRemoteSession(account, dsHeaders, 'session create');
            session.accountId = account.id;
            session.parentMessageId = null;
            session.createdAt = Date.now();
            session.lastActivityAt = Date.now();
            session.messageCount = 0;
            log(`${agentTag} Created new session${thinkingTag}: ${session.id}`);
        } else {
            log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
        }

        const powHeader = await solvePowForPath(account, dsHeaders, '/api/v0/chat/completion', 'completion');

        const sendCompletion = (parentMessageId, promptText, pow) => dsChatCompletionWithPow({
            sessionId: session.id,
            parentMessageId,
            prompt: promptText,
            powHeader: pow,
            dsHeaders,
            fileIds: effectiveFileIds,
            thinkingEnabled,
            searchEnabled,
        });

        let resp = await sendCompletion(session.parentMessageId, effectivePrompt, powHeader);

        const fullContextPrompt = freshSessionPrompt;
        const acceptedPromptTokens = () => {
            if (!fullContextPrompt) return;
            session.contextTokens = estimateTokens(fullContextPrompt);

            recordTokenRate(session, session.contextTokens);
        };

        if (TRANSIENT_STATUSES.has(resp.status)) {
            for (let attempt = 1; attempt <= TRANSIENT_MAX_ATTEMPTS && TRANSIENT_STATUSES.has(resp.status); attempt++) {

                if (clientGone() || deadlineHit()) break;
                const delay = TRANSIENT_BASE_DELAY_MS * (2 ** (attempt - 1));
                const jitter = Math.floor(Math.random() * TRANSIENT_BASE_DELAY_MS);
                log(`${agentTag} transient upstream HTTP ${resp.status}; retry ${attempt}/${TRANSIENT_MAX_ATTEMPTS} in ~${delay + jitter}ms`);
                await sleep(delay + jitter);
                if (clientGone() || deadlineHit()) break;
                const retryPow = await solvePowForPath(account, dsHeaders, '/api/v0/chat/completion', `completion transient retry ${attempt}`);
                resp = await sendCompletion(session.parentMessageId, effectivePrompt, retryPow);
            }
        }

        if (resp.status !== 200) {
            const retryAfter = resp.headers.get('retry-after');
            markAccountFailure(account, resp.status, 'completion', retryAfter);
            const errText = await resp.text();
            log(`${agentTag} Session error (${resp.status}): ${truncateForLog(errText, 100, '')}`);
            if (SESSION_EXPIRED_STATUSES.has(resp.status)) {
                log(`${agentTag} Session ${session.id} expired. Creating new session...`);
                resetRemoteSession(session);

                session.id = await createRemoteSession(account, dsHeaders, 'session recreate');
                session.accountId = account.id;
                session.parentMessageId = null;
                session.createdAt = Date.now();
                session.lastActivityAt = Date.now();
                log(`${agentTag} Created new session${thinkingTag}: ${session.id}`);

                const freshPow = await solvePowForPath(account, dsHeaders, '/api/v0/chat/completion', 'completion after session recreate');
                const resp2 = await sendCompletion(null, freshSessionPrompt, freshPow);
                if (!resp2.ok) {
                    const retryAfter2 = resp2.headers.get('retry-after');
                    markAccountFailure(account, resp2.status, 'completion after session recreate', retryAfter2);
                    const errText2 = await resp2.text();
                    throw createUpstreamHttpError(resp2.status, errText2, retryAfter2);
                }
                effectivePrompt = freshSessionPrompt;
                acceptedPromptTokens();
                return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true, fileIds: effectiveFileIds, fileIdsAccountId: effectiveFileIdsAccountId };
            }
            throw createUpstreamHttpError(resp.status, errText, retryAfter);
        }

        acceptedPromptTokens();
        return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: recoveredFreshSession, fileIds: effectiveFileIds, fileIdsAccountId: effectiveFileIdsAccountId };
    };
}

module.exports = { createUpstreamSession };
