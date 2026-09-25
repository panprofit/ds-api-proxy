'use strict';
// One upstream completion attempt, with transparent remote-session recreation.
// This control flow (expired-session detection, fresh-session fallback,
// recovery prompt selection) can be unit-tested with injected dependencies
// instead of a live DS connection.
//
// `createUpstreamSession(deps)` returns an `askDSStream({ prompt, agentId,
// freshSessionPrompt, fileIds, thinkingEnabled })` function. Options are passed
// as a single object so the positional list cannot keep growing and a caller
// cannot silently drop an argument (as previously happened with fileIds).
// Dependencies are injected so tests can stub the network without touching the
// real accounts/sessions singletons.

// Statuses that mean "this remote session is gone/foreign" rather than "the
// account is dead": recreate the session once and retry with the full prompt.
const SESSION_EXPIRED_STATUSES = new Set([400, 404, 409, 410, 500]);
// Transient upstream failures worth one bounded retry (with backoff) on the
// same account before surfacing the error. 5xx are often momentary.
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BASE_DELAY_MS = 300;

const { estimateTokens } = require('./openai');

function createUpstreamSession({
    getOrCreateAgentSession,
    prepareSessionForPrompt,
    resetRemoteSession,
    selectAccountForSession,
    markAccountFailure,
    solvePowForPath,
    createRemoteSession,
    dsChatCompletionWithPow,
    createUpstreamHttpError,
    log = console.log,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
    // Ask DS for one completion, transparently recreating an expired remote session.
    return async function askDSStream({
        prompt,
        agentId,
        freshSessionPrompt = prompt,
        fileIds = [],
        thinkingEnabled = undefined,
    }) {
        const session = getOrCreateAgentSession(agentId);
        const hadRemoteSession = Boolean(session.id);
        const account = selectAccountForSession(session, { resetRemoteSession });
        const dsHeaders = account.headers;
        account.lastUsedAt = Date.now();
        const agentTag = `[${agentId}/acct:${account.id}]`;
        // Thinking is a per-completion mode; rather than a standalone log line
        // on every request, tag the one session line already emitted below.
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

        const powHeader = await solvePowForPath(account, dsHeaders, '/api/v0/chat/completion', 'completion');

        if (!session.id) {
            session.id = await createRemoteSession(account, dsHeaders, 'session create');
            session.accountId = account.id;
            session.parentMessageId = null;
            session.createdAt = Date.now();
            session.messageCount = 0;
            log(`${agentTag} Created new session${thinkingTag}: ${session.id}`);
        } else {
            log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
        }

        const sendCompletion = (parentMessageId, promptText, pow) => dsChatCompletionWithPow({
            sessionId: session.id,
            parentMessageId,
            prompt: promptText,
            powHeader: pow,
            dsHeaders,
            fileIds,
            thinkingEnabled,
        });

        let resp = await sendCompletion(session.parentMessageId, effectivePrompt, powHeader);

        // After a successful call the remote session holds the FULL
        // conversation, which `freshSessionPrompt` always represents (system
        // prompt + tools + entire history). Report that size, not the size of
        // the per-turn delta `effectivePrompt` carries on a reused session:
        // summing deltas drops the system/tool text and the pre-existing
        // history, so usage.prompt_tokens came out far too low. Overwrite
        // rather than accumulate (a retried delta must not be counted twice).
        const fullContextPrompt = freshSessionPrompt;
        const acceptedPromptTokens = () => {
            if (!fullContextPrompt) return; // keep any prior estimate for empty prompts
            session.contextTokens = estimateTokens(fullContextPrompt);
        };

        // Bounded retry with backoff+jitter for transient 5xx on the same
        // account, before treating the session as expired. The PoW header is
        // time/nonce-bound, so it must be recomputed for every attempt rather
        // than reusing the one solved for the initial request.
        if (TRANSIENT_STATUSES.has(resp.status)) {
            for (let attempt = 1; attempt <= TRANSIENT_MAX_ATTEMPTS && TRANSIENT_STATUSES.has(resp.status); attempt++) {
                const delay = TRANSIENT_BASE_DELAY_MS * (2 ** (attempt - 1));
                const jitter = Math.floor(Math.random() * TRANSIENT_BASE_DELAY_MS);
                log(`${agentTag} transient upstream HTTP ${resp.status}; retry ${attempt}/${TRANSIENT_MAX_ATTEMPTS} in ~${delay + jitter}ms`);
                await sleep(delay + jitter);
                const retryPow = await solvePowForPath(account, dsHeaders, '/api/v0/chat/completion', `completion transient retry ${attempt}`);
                resp = await sendCompletion(session.parentMessageId, effectivePrompt, retryPow);
            }
        }

        if (resp.status !== 200) {
            const retryAfter = resp.headers.get('retry-after');
            markAccountFailure(account, resp.status, 'completion', retryAfter);
            const errText = await resp.text();
            log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
            if (SESSION_EXPIRED_STATUSES.has(resp.status)) {
                log(`${agentTag} Session ${session.id} expired. Creating new session...`);
                resetRemoteSession(session);

                session.id = await createRemoteSession(account, dsHeaders, 'session recreate');
                session.accountId = account.id;
                session.parentMessageId = null;
                session.createdAt = Date.now();
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
                return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true };
            }
            throw createUpstreamHttpError(resp.status, errText, retryAfter);
        }

        acceptedPromptTokens();
        return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: recoveredFreshSession };
    };
}

module.exports = { createUpstreamSession };
