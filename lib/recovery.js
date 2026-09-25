'use strict';
// Request recovery orchestration: empty-retry, auto-continuation,
// markup-completion and account-rotation loops, plus the final tool-call
// extraction. These control-flow-heavy paths can be unit-tested by injecting
// the upstream call / SSE reader.
//
// Design: this module owns NO network or HTTP objects. `index.js` passes in
// the functions it already uses (`askDSStream`, `readDSResponse`) plus the
// request context (session, prompts, tools, callbacks). The module returns a
// result describing what the caller should send back, or throws / returns an
// `errorResponse` for terminal failures.
//
// The per-request recovery passes are split into module-level functions that
// share a single mutable `state` object (fullContent, reasoningContent,
// finishReason, modelError, prompts, toolCall) and a read-only `deps` bundle
// (session, callbacks, injected upstream functions). Keeping them at module
// scope makes each pass independently reviewable; they mutate `state` in place.

const {
    sanitizeContent,
    isContinuationRecoverySafe,
    isContextTooLongError,
    isRefusalContent,
    normalizeRetryResponse,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    isAuthExpiredError,
} = require('./recovery-classify');
const {
    composePrompt,
    appendPromptInstruction,
    collectPendingTurns,
    markTurnsSent,
    formatPendingTurns,
    extractScreenshotPaths,
} = require('./prompt');

const { parseToolCall, looksLikeToolCallMarkup } = require('./parser');
const accounts = require('./accounts');
const sessions = require('./sessions');


// Read recovery knobs at call time (not a load-time snapshot), matching the
// request path in handlers.js. The exported constants below are a load-time
// snapshot kept for back-compat with tests that import them.
const { currentConfig, retryDelayMs, sleep, backoffDelay } = require('./recovery-util');
const { runMarkupCompletion, runStrictToolRetry } = require('./recovery-markup');

// Abandon the session's current account and try to rotate to a healthy one.
//
// Always resets the remote session (releasing the sticky account) so the next
// loop iteration re-selects via round-robin. The failure snapshot is returned
// so the caller can build a terminal error body if no account is available.
//
// Returns { failure, rotated }:
//   rotated=true  -> an account is ready; the caller should `continue` the loop
//   rotated=false -> nothing available (or the client is gone); the caller
//                    should return a terminal error using `failure`.
async function rotateAccountAfterFailure({ session, accountAttempt, agentTag, reason, log, clientGone, deadlineHit }) {
    const failure = sessions.resetRemoteSession(session, { releaseAccount: true });
    if (clientGone() || !(await accounts.waitForAvailableAccount(deadlineHit))) {
        return { failure, rotated: false };
    }
    log(`${agentTag} ${reason} on ${failure.accountId}; rotating to next account (attempt ${accountAttempt + 2})...`);
    await sleep(backoffDelay(accountAttempt + 1, retryDelayMs()));
    return { failure, rotated: true };
}

// Retry empty / context-too-long responses on the SAME account. Mutates
// `state` in place. Returns true when the client disconnected, in which case
// the caller must abort the whole request.
async function runEmptyRetries(state, deps) {
    const {
        agentId, agentTag, session, prompt, systemPrompt,
        askDSStream, readDSResponse, fileIds, thinkingEnabled,
        maxEmptyRetries, clientGone, deadlineHit, log,
    } = deps;

    state.retryAttempt = 0;
    while (!state.fullContent || state.fullContent.trim().length === 0) {
        if (clientGone()) { log(`${agentTag} client disconnected; abandoning empty-retry loop`); return true; }
        if (deadlineHit()) { log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
        // A reasoning-only response is not "empty": the model produced thinking
        // but no final text. Retrying the same prompt just hits the same
        // token-budget wall, so stop here instead of burning retries (and
        // wrongly cooling the account down).
        if (state.reasoningContent && state.reasoningContent.trim().length > 0
            && !isContextTooLongError(state.modelError)) break;
        const contextTooLong = isContextTooLongError(state.modelError);
        if (state.modelError && !contextTooLong) break;
        if (state.retryAttempt >= maxEmptyRetries) break;
        state.retryAttempt++;

        const retryPrompt = composePrompt(systemPrompt, prompt);
        const reason = contextTooLong ? 'context-too-long response' : 'empty response';
        log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${state.retryAttempt}/${maxEmptyRetries}, prompt=${retryPrompt.length} chars). Resetting session...`);
        sessions.resetRemoteSession(session);
        await sleep(backoffDelay(state.retryAttempt, retryDelayMs()));
        const { resp: retryResp } = await askDSStream({ prompt: retryPrompt, agentId, freshSessionPrompt: retryPrompt, fileIds, thinkingEnabled });
        const retryResult = await readDSResponse(retryResp.body, session, agentTag);
        const retryState = normalizeRetryResponse(retryResult);
        state.fullPrompt = retryPrompt;
        state.modelError = retryState.modelError;
        state.finishReason = retryState.finishReason;
        if (retryState.content && retryState.content.trim().length > 0) {
            log(`${agentTag} Retry ${state.retryAttempt} succeeded`);
            state.fullContent = retryState.content;
            state.reasoningContent = retryState.reasoningContent;
        }
    }
    return false;
}

// Auto-continue a long / length-finished response by asking the model to pick
// up where it stopped. Mutates `state` in place.
async function runAutoContinuation(state, deps) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, fileIds, thinkingEnabled, clientGone, deadlineHit, log } = deps;

    const { maxContinuation: MAX_CONTINUATION, continuationSizeThreshold: CONTINUATION_SIZE_THRESHOLD } = currentConfig();
    let continuationRounds = 0;
    // Never auto-continue from an empty body (e.g. a reasoning-only response):
    // there is nothing to resume and the continuation prompt would be blank.
    while (state.fullContent.length > 0
        && (state.finishReason === 'length' || state.fullContent.length > CONTINUATION_SIZE_THRESHOLD)
        && continuationRounds < MAX_CONTINUATION) {
        if (clientGone() || deadlineHit()) break;
        continuationRounds++;
        log(`${agentTag} Response ${state.fullContent.length} chars (finish=${state.finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
        await sleep(retryDelayMs());
        const contBeforeId = session.accountId;
        const continuationRecoveryPrompt = appendPromptInstruction(
            `${state.freshPrompt}\n\n[Assistant response so far]\n${state.fullContent}`,
            'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
        );
        const continuationCall = await askDSStream({ prompt: 'continue', agentId, freshSessionPrompt: continuationRecoveryPrompt, fileIds, thinkingEnabled });
        const contResp = continuationCall.resp;
        const contAccount = continuationCall.account;
        if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
            log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping (foreign session)`);
            sessions.resetRemoteSession(session);
            break;
        }
        const contResult = await readDSResponse(contResp.body, session, agentTag);
        const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
        const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
        // A "continuation" that is really a model refusal (e.g. "I am an AI…")
        // must not be appended. The marker list lives in recovery-classify so
        // it can be extended in one place.
        if (contContent && contContent.trim().length > 0 && !isRefusalContent(contContent)) {
            state.fullContent += '\n' + contContent;
            if (contReasoning) state.reasoningContent += (state.reasoningContent ? '\n' : '') + contReasoning;
            state.finishReason = contResult.finishReason;
            log(`${agentTag} Continuation added ${contContent.length} chars (total: ${state.fullContent.length})`);
        } else {
            log(`${agentTag} Continuation returned nothing useful, stopping`);
            break;
        }
    }
}

// A reasoning-only response (thinking emitted, no final text) is not an empty
// response and not a broken account, but it does leave the user with nothing
// visible and forces a manual "continue". Ask the model to turn its reasoning
// into the final answer, bounded by maxReasoningContinuation rounds.
async function runReasoningOnlyContinuation(state, deps) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, fileIds, thinkingEnabled, clientGone, deadlineHit, log } = deps;
    const { maxReasoningContinuation: MAX_REASONING_CONTINUATION } = currentConfig();
    let rounds = 0;
    while ((!state.fullContent || state.fullContent.trim().length === 0)
        && state.reasoningContent && state.reasoningContent.trim().length > 0
        && rounds < MAX_REASONING_CONTINUATION) {
        if (clientGone() || deadlineHit()) break;
        rounds++;
        log(`${agentTag} reasoning-only response; asking for the final answer (${rounds}/${MAX_REASONING_CONTINUATION})...`);
        await sleep(retryDelayMs());
        const beforeId = session.accountId;
        const prompt = appendPromptInstruction(
            `${state.freshPrompt}\n\n[Your reasoning]\n${state.reasoningContent}`,
            'You produced reasoning but no visible answer. Now output ONLY the final answer to the user, based on your reasoning above. Do not repeat the reasoning and do not restate the question.'
        );
        const call = await askDSStream({ prompt: 'continue', agentId, freshSessionPrompt: prompt, fileIds, thinkingEnabled });
        if (!isContinuationRecoverySafe(beforeId, call)) {
            log(`${agentTag} reasoning continuation rotated account; skipping`);
            sessions.resetRemoteSession(session);
            break;
        }
        const result = await readDSResponse(call.resp.body, session, agentTag);
        const content = result && result.content ? sanitizeContent(result.content) : '';
        const reasoning = result && result.reasoningContent ? sanitizeContent(result.reasoningContent) : '';
        if (content && content.trim().length > 0 && !isRefusalContent(content)) {
            state.fullContent = content;
            if (reasoning) state.reasoningContent += (state.reasoningContent ? '\n' : '') + reasoning;
            state.finishReason = result.finishReason;
            log(`${agentTag} Reasoning continuation produced ${content.length} chars of final answer`);
        } else if (reasoning && reasoning.trim().length > 0) {
            // Still only thinking: keep the extra reasoning and try again next
            // round (bounded by MAX_REASONING_CONTINUATION).
            state.reasoningContent += (state.reasoningContent ? '\n' : '') + reasoning;
            log(`${agentTag} Reasoning continuation produced more reasoning but no answer; retrying`);
        } else {
            log(`${agentTag} Reasoning continuation returned nothing useful, stopping`);
            break;
        }
    }
}
// Returns one of:
//   { ok: true, fullContent, reasoningContent, finishReason, toolCall, fullPrompt,
//     pendingTurns, reusingRemoteSession, messageCount }
//   { ok: false, error: { status, body } }  // terminal, caller writes it as JSON
// Throws only for truly unexpected programmer errors.
async function runWithRecovery(ctx) {
    const {
        // request context
        agentId, agentTag, session, messages, tools, prompt, systemPrompt,
        // upstream + stream reader (injected)
        askDSStream, readDSResponse,
        // options
        fileIds = [],
        thinkingEnabled = undefined,
        maxEmptyRetries,
        malformedCooldownMs,
        // callbacks
        clientGone = () => false,
        deadlineHit = () => false,
        log = console.log,
    } = ctx;

    const maxAccountAttempts = Math.max(1, accounts.getAccounts().length);
    const maxSessionResetsPerAccount = Math.max(1, currentConfig().maxSessionResetsPerAccount);

    // Mutable per-request state shared by the recovery passes below.
    const state = {
        fullContent: '',
        reasoningContent: '',
        finishReason: null,
        modelError: null,
        fullPrompt: '',
        freshPrompt: '',
        reusingRemoteSession: false,
        pendingTurns: [],
        allowedToolNames: new Set(),
        toolCall: null,
        retryAttempt: 0,
        // Same-account retries already spent on a transient DS upstream outage,
        // plus the account they belong to (a rotation resets the counter).
        upstreamRetryAttempt: 0,
        upstreamRetryAccountId: null,
        // Once the same-session retries above are exhausted, one last attempt is
        // made in a FRESH remote session (full context) in case DS marked the
        // old session bad. This flag makes that happen at most once per account.
        upstreamFreshRetryDone: false,
    };

    // Read-only dependencies shared by the passes.
    const deps = {
        agentId, agentTag, session, messages, tools, prompt, systemPrompt,
        askDSStream, readDSResponse, fileIds, thinkingEnabled,
        maxEmptyRetries, clientGone, deadlineHit, log,
    };

    let accountAttempt = 0;
    while (accountAttempt < maxAccountAttempts) {
        // When a remote DS session already exists, only forward the turns it has
        // not seen yet. The full conversation is kept in `freshPrompt` for the
        // case where the session has to be recreated from scratch.
        state.reusingRemoteSession = Boolean(session.id);
        state.pendingTurns = state.reusingRemoteSession ? collectPendingTurns(messages, session) : [];
        const incrementalPrompt = state.pendingTurns.length > 0 ? formatPendingTurns(state.pendingTurns) : '';

        const conversationPrompt = state.reusingRemoteSession
            ? (incrementalPrompt || prompt)
            : prompt;

        state.fullPrompt = state.reusingRemoteSession
            ? composePrompt('', conversationPrompt)
            : composePrompt(systemPrompt, conversationPrompt);
        state.freshPrompt = composePrompt(systemPrompt, prompt);
        if (state.reusingRemoteSession) {
            log(`${agentTag} Incremental prompt: ${state.pendingTurns.length} pending turn(s), ${incrementalPrompt.length} chars (full conversation would be ${prompt.length} chars)`);
        }

        let initialCall;
        try {
            initialCall = await askDSStream({ prompt: state.fullPrompt, agentId, freshSessionPrompt: state.freshPrompt, fileIds, thinkingEnabled });
        } catch (e) {
            // "Auth may be expired, captcha may be required, or DS changed Web
            // API" (and the equivalent session-create failure) means this
            // account's credentials are unusable. Retrying the same account
            // cannot help, so cool it down and rotate to the next one.
            if (!isAuthExpiredError(e)) throw e;
            const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
            accounts.markAccountBroken(usedAccount, 'auth expired / captcha / DS Web API change');
            const { failure, rotated } = await rotateAccountAfterFailure({
                session, accountAttempt, agentTag, reason: 'auth expired (captcha/Web API)',
                log, clientGone, deadlineHit,
            });
            if (rotated) { accountAttempt++; continue; }
            const allCooling = !accounts.hasAvailableAccount();
            log(`${agentTag} auth expired on all ${accountAttempt + 1} account attempt(s). Giving up.`);
            return { ok: false, error: {
                status: allCooling ? 429 : 401,
                body: {
                    message: allCooling
                        ? 'All auth accounts are cooling down after auth failures. Add a fresh account config or retry later.'
                        : (e.message || 'DS auth expired'),
                    type: allCooling ? 'rate_limit_error' : 'auth_expired',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    account: failure.accountId,
                    account_attempts: accountAttempt + 1,
                },
            } };
        }
        const dsResp = initialCall.resp;
        if (initialCall.promptUsed !== state.fullPrompt) {
            state.fullPrompt = initialCall.promptUsed;
        }

        ({ content: state.fullContent, reasoningContent: state.reasoningContent, finishReason: state.finishReason, modelError: state.modelError } = await readDSResponse(dsResp.body, session, agentTag));
        state.fullContent = sanitizeContent(state.fullContent);
        state.reasoningContent = sanitizeContent(state.reasoningContent || '');
        log(`${agentTag} Got ${state.fullContent.length} chars (+${state.reasoningContent.length} reasoning chars) (msg#${session.messageCount})`);

        // --- empty-response retries (same account) ---
        if (await runEmptyRetries(state, deps)) return { ok: false, clientGone: true };

        // --- still empty: cool the account and rotate, or fail terminally ---
        // A response with reasoning but no final content is NOT a broken
        // account: the model thought but hit its token budget before emitting
        // text. Cooling the account down here would (a) penalise a healthy
        // account and (b) reproduce on every account with the same prompt, so
        // we fall through and return the reasoning as-is instead.
        const hasReasoningOnly = (!state.fullContent || state.fullContent.trim().length === 0)
            && state.reasoningContent && state.reasoningContent.trim().length > 0
            && !state.modelError;
        if (hasReasoningOnly) {
            log(`${agentTag} reasoning-only response (${state.reasoningContent.length} reasoning chars, 0 content); asking for the final answer.`);
            await runReasoningOnlyContinuation(state, deps);
        }
        if ((!state.fullContent || state.fullContent.trim().length === 0) && !hasReasoningOnly) {
            const timedOut = deadlineHit();
            const failureClass = classifyRecoveryFailure(state.modelError, timedOut);
            const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
            if (isUpstreamTransientError(state.modelError)) {
                // DS itself is briefly unavailable (finish_reason=generation_err,
                // "Server temporarily unavailable."). The account is healthy, so
                // rotating cannot help: every account talks to the same
                // upstream and the next one fails identically. Retry the SAME
                // account up to maxUpstreamRetries, then surface the error to
                // the client without touching the account.
                if (clientGone()) return { ok: false, clientGone: true };
                // Retries are per account: reset the counter if the sticky
                // account changed since the last outage.
                if (state.upstreamRetryAccountId !== session.accountId) {
                    state.upstreamRetryAccountId = session.accountId;
                    state.upstreamRetryAttempt = 0;
                    state.upstreamFreshRetryDone = false;
                }
                const { maxUpstreamRetries } = currentConfig();
                if (state.upstreamRetryAttempt < maxUpstreamRetries && !deadlineHit()) {
                    state.upstreamRetryAttempt++;
                    log(`${agentTag} DS upstream temporarily unavailable (${state.modelError?.content || 'generation_err'}); not penalising account ${usedAccount?.id || 'n/a'}, retrying the last turn in the SAME session (${state.upstreamRetryAttempt}/${maxUpstreamRetries})...`);
                    // Do NOT reset the remote session: a DS-side outage is
                    // transient and the session is still valid. Retrying the
                    // last turn in place avoids re-sending the full context and
                    // the extra create/delete round-trips. readDSResponse()
                    // leaves parentMessageId untouched on a model error, so the
                    // retry branches from the previous valid message.
                    await sleep(backoffDelay(state.upstreamRetryAttempt, retryDelayMs()));
                    continue;
                }
                // Same-session retries are exhausted. If DS still reports the
                // outage, try once more in a FRESH remote session (full context)
                // in case the old session itself was marked bad, then give up.
                if (!state.upstreamFreshRetryDone && !deadlineHit()) {
                    state.upstreamFreshRetryDone = true;
                    log(`${agentTag} DS upstream temporarily unavailable after ${state.upstreamRetryAttempt} same-session retr${state.upstreamRetryAttempt === 1 ? 'y' : 'ies'}; recreating the remote session and retrying once with the full context...`);
                    sessions.resetRemoteSession(session);
                    await sleep(backoffDelay(state.upstreamRetryAttempt || 1, retryDelayMs()));
                    continue;
                }
                log(`${agentTag} DS upstream temporarily unavailable after ${state.upstreamRetryAttempt} retr${state.upstreamRetryAttempt === 1 ? 'y' : 'ies'} on account ${usedAccount?.id || 'n/a'}; giving up.`);
                return { ok: false, error: {
                    status: failureClass.status,
                    body: {
                        message: state.modelError?.content || 'DS upstream temporarily unavailable',
                        type: failureClass.type,
                        agent: agentId,
                        failed_session_id: session.id,
                        message_count: session.messageCount,
                        account: session.accountId,
                        upstream_retries: state.upstreamRetryAttempt,
                    },
                } };
            }
            if (state.modelError?.type === 'rate_limit' || state.modelError?.finish_reason === 'rate_limit_reached') {
                accounts.markAccountFailure(usedAccount, 429, 'rate-limit-empty-response');
            } else {
                // An empty/malformed stream is usually a transient model or
                // protocol glitch, NOT a dead account. Use the short
                // recoverable-failure cooldown (same as malformed tool markup)
                // instead of the long accountCooldownMs, otherwise a single
                // upstream protocol change parks every account for minutes.
                accounts.markAccountBroken(usedAccount, `empty response (${failureClass.type})`, malformedCooldownMs);
            }
            // `waitForAvailableAccount` returns the *current* availability, so
            // a single call covers both the immediate and the wait-then-check cases.
            const { failure, rotated } = await rotateAccountAfterFailure({
                session, accountAttempt, agentTag, reason: failureClass.type,
                log, clientGone, deadlineHit,
            });
            if (rotated) { accountAttempt++; continue; }
            const errorType = failureClass.type;
            const errorMessage = state.modelError?.content
                || (timedOut
                    ? 'DS request deadline reached while recovering an empty response'
                    : `DS returned empty content after ${state.retryAttempt} retr${state.retryAttempt === 1 ? 'y' : 'ies'}`);
            log(`${agentTag} ${errorType} after ${state.retryAttempt} retr${state.retryAttempt === 1 ? 'y' : 'ies'} and ${accountAttempt + 1} account attempt(s). Giving up.`);
            const allCooling = !accounts.hasAvailableAccount();
            return { ok: false, error: {
                status: allCooling ? 429 : failureClass.status,
                body: {
                    message: allCooling
                        ? 'All auth accounts are cooling down after repeated recoverable failures. Retry later.'
                        : errorMessage,
                    type: allCooling ? 'rate_limit_error' : errorType,
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    account: failure.accountId,
                    retry_attempts: state.retryAttempt,
                    account_attempts: accountAttempt + 1,
                    upstream_prompt_chars: state.fullPrompt.length,
                },
            } };
        }

        // --- auto-continuation for long / length-finished responses ---
        await runAutoContinuation(state, deps);

        // --- tool-call extraction + unclosed-markup completion ---
        state.allowedToolNames = new Set(tools
            .filter(tool => tool?.type === 'function' && tool.function?.name)
            .map(tool => tool.function.name));
        state.toolCall = state.allowedToolNames.size > 0 ? parseToolCall(state.fullContent) : null;
        if (state.toolCall && !state.allowedToolNames.has(state.toolCall.name)) {
            log(`${agentTag} Model requested unknown tool ${state.toolCall.name}; attempting format repair.`);
            state.toolCall = null;
        }

        await runMarkupCompletion(state, deps);
        await runStrictToolRetry(state, deps);

        // --- irreparably broken markup: rotate account or fail ---
        // Note: an *unknown* tool name (parsed but not in allowedToolNames) is
        // NOT broken markup — the JSON was valid, the model just asked for a
        // tool we don't expose. Only rotate when the markup cannot be parsed at
        // all but still looks like a tool call. Parse once here (the content may
        // have changed in the completion/retry passes above) and reuse it.
        const hasBrokenToolMarkup = state.allowedToolNames.size > 0
            && !state.toolCall
            && looksLikeToolCallMarkup(state.fullContent)
            && parseToolCall(state.fullContent) === null;
        if (hasBrokenToolMarkup) {
            // A malformed tool call is usually a bad remote session, not a dead
            // account. Recreate the session on the SAME account first and only
            // rotate the account after `maxSessionResetsPerAccount` consecutive
            // session recreations.
            session.malformedResets = (session.malformedResets || 0) + 1;
            if (session.malformedResets < maxSessionResetsPerAccount) {
                log(`${agentTag} Broken tool markup (session reset ${session.malformedResets}/${maxSessionResetsPerAccount}); recreating remote session on the same account.`);
                sessions.resetRemoteSession(session);
                await sleep(backoffDelay(session.malformedResets, retryDelayMs()));
                continue;
            }
            session.malformedResets = 0;
            const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
            accounts.markAccountBroken(usedAccount, 'malformed tool-call markup', malformedCooldownMs);
            const { failure, rotated } = await rotateAccountAfterFailure({
                session, accountAttempt, agentTag, reason: 'malformed tool-call markup',
                log, clientGone, deadlineHit,
            });
            if (rotated) { accountAttempt++; continue; }
            const allCooling = !accounts.hasAvailableAccount();
            log(`${agentTag} Broken tool markup; recreating remote session.`);
            return { ok: false, error: {
                status: allCooling ? 429 : 502,
                body: {
                    message: allCooling
                        ? 'All auth accounts are cooling down after repeated malformed tool-call markup. Retry later.'
                        : 'DS returned malformed tool-call markup after one repair attempt',
                    type: allCooling ? 'rate_limit_error' : 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    account: failure.accountId,
                    session_preserved: false,
                    account_attempts: accountAttempt + 1,
                },
            } };
        }

        // Valid response this attempt; stop rotating.
        break;
    }

    // MEDIA: path injection for screenshots found in prior tool results.
    if (!state.fullContent.includes('MEDIA:')) {
        const screenshotPaths = extractScreenshotPaths(messages);
        if (screenshotPaths.length > 0) {
            state.fullContent += '\n\n' + screenshotPaths.join('\n');
            log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
        }
    }

    // A clean completion clears the consecutive malformed-markup counter.
    session.malformedResets = 0;

    // Everything that went upstream is now part of the remote session. On a
    // fresh session the full `messages` list was forwarded; on a reused one
    // only `pendingTurns`. Marking in both cases prevents the same turns
    // (and their image attachments) from being treated as pending again on
    // the next request.
    if (state.reusingRemoteSession) {
        if (state.pendingTurns.length > 0) markTurnsSent(session, state.pendingTurns);
    } else {
        markTurnsSent(session, messages);
    }

    return {
        ok: true,
        fullContent: state.fullContent,
        reasoningContent: state.reasoningContent,
        finishReason: state.finishReason,
        toolCall: state.toolCall,
        fullPrompt: state.fullPrompt,
        // Estimated size of the full context the current remote session holds
        // (system prompt + tools + entire history), even though only the
        // per-turn delta travelled upstream on a reused session.
        contextTokens: session.contextTokens || 0,
        pendingTurns: state.pendingTurns,
        reusingRemoteSession: state.reusingRemoteSession,
        retryAttempt: state.retryAttempt,
    };
}

module.exports = {
    backoffDelay,
    rotateAccountAfterFailure,
    runWithRecovery,
};
