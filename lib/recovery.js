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
// runWithRecovery() is a small explicit state machine. Each recovery concern is
// a module-level *phase* function (`beginAttempt`, `phaseEmptyRetries`, …) that
// mutates the shared `state` object and returns one of four transitions:
//
//   null            - phase did not terminate the attempt; run the next phase
//   RETRY           - re-run the whole phase list on the SAME account
//   ROTATE          - advance to the next account and re-run the phase list
//   SUCCESS         - the response is valid; leave the loop and finalize
//   terminal(result)- stop now and return `result` to the caller
//
// The driver loop below interprets those transitions. Keeping the decisions in
// named, individually reviewable functions replaces the previous single ~300
// line `while` body whose `continue`/`break`/`return` targets were easy to
// misread. The transition values are pure data, so the control flow is visible
// at the call site instead of hidden in inline jumps.

const {
    sanitizeContent,
    isContinuationRecoverySafe,
    isContextTooLongError,
    isRefusalContent,
    isToolResultEcho,
    normalizeRetryResponse,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    isAuthExpiredError,
    looksLikeActionPromise,
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
const { currentConfig, retryDelayMs, sleep, backoffDelay, memoizeParse } = require('./recovery-util');
const { runMarkupCompletion, runStrictToolRetry } = require('./recovery-markup');
const metrics = require('./metrics');

// Continuation calls (auto-continue, reasoning-only, action-promise) all share
// the same safety envelope: issue an upstream call, reject it if it landed on
// a different account than the one the session is pinned to (a foreign-session
// result must never be merged into our state), then read + sanitize the body.
// Centralised so no call site can forget the account-affinity check.
//
// Returns { content, reasoningContent, finishReason, modelError, raw } on
// success, or null when the call rotated to another account (the caller must
// stop and let the outer loop re-run the phase list).
async function runContinuationCall(state, deps, { incrementalPrompt, freshSessionPrompt, label }) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, clientGone, deadlineHit, log } = deps;
    const beforeId = session.accountId;
    const call = await askDSStream({
        prompt: incrementalPrompt, agentId,
        freshSessionPrompt,
        fileIds: deps.fileIds,
        thinkingEnabled: deps.thinkingEnabled,
        searchEnabled: deps.searchEnabled,
        deadlineHit, clientGone,
    });
    if (!isContinuationRecoverySafe(beforeId, call)) {
        log(`${agentTag} ${label} continuation rotated account; skipping`);
        sessions.resetRemoteSession(session);
        return null;
    }
    const raw = await readDSResponse(call.resp.body, session, agentTag);
    return {
        content: raw && raw.content ? sanitizeContent(raw.content) : '',
        reasoningContent: raw && raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : '',
        finishReason: raw && raw.finishReason,
        modelError: (raw && raw.modelError) || null,
        raw,
    };
}

// --- state-machine transitions ---------------------------------------------
// Frozen singletons so a phase can `return RETRY` without allocating; the
// driver only ever reads `.kind`. `terminal()` wraps a caller-facing result.
const RETRY = Object.freeze({ kind: 'retry' });
const ROTATE = Object.freeze({ kind: 'rotate' });
const SUCCESS = Object.freeze({ kind: 'success' });
function terminal(result) { return { kind: 'terminal', result }; }

// Build a terminal error result. `allCooling` short-circuits to the shared
// 429 rate-limit shape used by every recovery give-up path, so callers only
// declare the non-cooling status/type/message. `failure` (from
// rotateAccountAfterFailure/resetRemoteSession) contributes the session
// snapshot fields when present.
function terminalError({ status, type, message, allCooling = false, agentId, failure, extra }) {
    const body = {
        message: allCooling && !message ? 'All auth accounts are cooling down after repeated recoverable failures. Retry later.' : message,
        type: allCooling ? 'rate_limit_error' : type,
        agent: agentId,
        ...(failure ? {
            failed_session_id: failure.failedSessionId,
            message_count: failure.failedMessageCount,
            account: failure.accountId,
        } : {}),
        ...(extra || {}),
    };
    return terminal({ ok: false, error: { status: allCooling ? 429 : status, body } });
}

// Abandon the session's current account and try to rotate to a healthy one.
//
// Always resets the remote session (releasing the sticky account) so the next
// loop iteration re-selects via least-recently-used. The failure snapshot is
// returned
// so the caller can build a terminal error body if no account is available.
//
// Returns { failure, rotated }:
//   rotated=true  -> an account is ready; the caller should return ROTATE
//   rotated=false -> nothing available (or the client is gone); the caller
//                    should return a terminal error using `failure`.
async function rotateAccountAfterFailure({ session, accountAttempt, agentTag, reason, log, clientGone, rotationDeadlineHit }) {
    const failure = sessions.resetRemoteSession(session, { releaseAccount: true });
    if (clientGone() || !(await accounts.waitForAvailableAccount(rotationDeadlineHit, { clientGone }))) {
        return { failure, rotated: false };
    }
    metrics.inc('rotations');
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
        askDSStream, readDSResponse, fileIds, thinkingEnabled, searchEnabled,
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
        // A context-too-long response is deterministic: resending the SAME
        // prompt to the SAME session just hits the same limit again. Do not
        // burn empty-retries on it -- fall through to phaseEmptyResponse,
        // which classifies it as a terminal context_length_exceeded (400).
        if (contextTooLong) {
            log(`${agentTag} context-too-long response; skipping empty retries.`);
            break;
        }
        if (state.modelError) break;
        // A muted account answers every retry with the same mute payload, so
        // stop immediately and let phaseEmptyResponse park it until mute_until.
        if (state.muted) { log(`${agentTag} account muted; skipping empty retries.`); break; }
        if (state.retryAttempt >= maxEmptyRetries) break;
        state.retryAttempt++;

        const retryPrompt = composePrompt(systemPrompt, prompt);
        const reason = 'empty response';
        log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${state.retryAttempt}/${maxEmptyRetries}, prompt=${retryPrompt.length} chars). Resetting session...`);
        sessions.resetRemoteSession(session);
        await sleep(backoffDelay(state.retryAttempt, retryDelayMs()));
        const { resp: retryResp } = await askDSStream({ prompt: retryPrompt, agentId, freshSessionPrompt: retryPrompt, fileIds, thinkingEnabled, searchEnabled, deadlineHit, clientGone });
        const retryResult = await readDSResponse(retryResp.body, session, agentTag);
        const retryState = normalizeRetryResponse(retryResult);
        state.fullPrompt = retryPrompt;
        state.modelError = retryState.modelError;
        state.finishReason = retryState.finishReason;
        if (retryResult.muted) state.muted = retryResult.muted;
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
    const { agentTag, clientGone, deadlineHit, log } = deps;

    const { maxContinuation: MAX_CONTINUATION, continuationSizeThreshold: CONTINUATION_SIZE_THRESHOLD } = currentConfig();
    let continuationRounds = 0;
    // Never auto-continue from an empty body (e.g. a reasoning-only response):
    // there is nothing to resume and the continuation prompt would be blank.
    //
    // Intentional: this triggers on `finishReason === 'length'` OR on a body
    // longer than CONTINUATION_SIZE_THRESHOLD even when the model already
    // reported `stop`. A very long answer that ended cleanly is usually a
    // premature stop (the model capped itself mid-thought), so one more round
    // with an explicit "continue" prompt recovers the rest. Set
    // DS_CONTINUATION_SIZE_THRESHOLD very high (or DS_MAX_CONTINUATION=0) to
    // disable this and only ever continue `length`-truncated responses.
    while (state.fullContent.length > 0
        && (state.finishReason === 'length' || state.fullContent.length > CONTINUATION_SIZE_THRESHOLD)
        && continuationRounds < MAX_CONTINUATION) {
        if (clientGone() || deadlineHit()) break;
        continuationRounds++;
        log(`${agentTag} Response ${state.fullContent.length} chars (finish=${state.finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
        await sleep(retryDelayMs());
        const continuationRecoveryPrompt = appendPromptInstruction(
            `${state.freshPrompt}\n\n[Assistant response so far]\n${state.fullContent}`,
            'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
        );
        const cont = await runContinuationCall(state, deps, {
            incrementalPrompt: 'continue',
            freshSessionPrompt: continuationRecoveryPrompt,
            label: 'auto',
        });
        if (!cont) break;
        // A "continuation" that is really a model refusal (e.g. "I am an AI…")
        // must not be appended. The marker list lives in recovery-classify so
        // it can be extended in one place.
        if (cont.content && cont.content.trim().length > 0 && !isRefusalContent(cont.content)
            && !isToolResultEcho(cont.content)) {
            state.fullContent += '\n' + cont.content;
            if (cont.reasoningContent) state.reasoningContent += (state.reasoningContent ? '\n' : '') + cont.reasoningContent;
            state.finishReason = cont.finishReason;
            log(`${agentTag} Continuation added ${cont.content.length} chars (total: ${state.fullContent.length})`);
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
    const { agentTag, clientGone, deadlineHit, log } = deps;
    const { maxReasoningContinuation: MAX_REASONING_CONTINUATION } = currentConfig();
    let rounds = 0;
    while ((!state.fullContent || state.fullContent.trim().length === 0)
        && state.reasoningContent && state.reasoningContent.trim().length > 0
        && rounds < MAX_REASONING_CONTINUATION) {
        if (clientGone() || deadlineHit()) break;
        rounds++;
        log(`${agentTag} reasoning-only response; asking for the final answer (${rounds}/${MAX_REASONING_CONTINUATION})...`);
        await sleep(retryDelayMs());
        // The explicit instruction must travel as the *incremental* prompt, not
        // only inside `freshSessionPrompt`: on a reused remote session
        // askDSStream sends `prompt` upstream and ignores `freshSessionPrompt`.
        // Passing the literal word "continue" (as the auto-continuation path
        // does for a truncated answer) left the model unaware it had to emit a
        // final answer, so it kept producing reasoning, the loop exhausted its
        // rounds, and an empty body stalled the client until a manual continue.
        // The reasoning is carried in the incremental turn too: a reasoning-only
        // turn does not reliably advance the remote parent, so the model may
        // not see its own reasoning in-session.
        const finalAnswerInstruction = 'You produced reasoning but no visible answer. Now output ONLY the final answer to the user, based on your reasoning above. Do not repeat the reasoning and do not restate the question.';
        const incrementalPrompt = appendPromptInstruction(`[Your reasoning]\n${state.reasoningContent}`, finalAnswerInstruction);
        const freshPrompt = appendPromptInstruction(
            `${state.freshPrompt}\n\n[Your reasoning]\n${state.reasoningContent}`,
            finalAnswerInstruction
        );
        const result = await runContinuationCall(state, deps, {
            incrementalPrompt,
            freshSessionPrompt: freshPrompt,
            label: 'reasoning',
        });
        if (!result) break;
        if (result.content && result.content.trim().length > 0 && !isRefusalContent(result.content)
            && !isToolResultEcho(result.content)) {
            state.fullContent = result.content;
            if (result.reasoningContent) state.reasoningContent += (state.reasoningContent ? '\n' : '') + result.reasoningContent;
            state.finishReason = result.finishReason;
            log(`${agentTag} Reasoning continuation produced ${result.content.length} chars of final answer`);
        } else if (result.reasoningContent && result.reasoningContent.trim().length > 0) {
            // Still only thinking: keep the extra reasoning and try again next
            // round (bounded by MAX_REASONING_CONTINUATION).
            state.reasoningContent += (state.reasoningContent ? '\n' : '') + result.reasoningContent;
            log(`${agentTag} Reasoning continuation produced more reasoning but no answer; retrying`);
        } else {
            log(`${agentTag} Reasoning continuation returned nothing useful, stopping`);
            break;
        }
    }
}

// --- recovery phases --------------------------------------------------------
// Each phase is `async (state, deps, ctl) -> transition | null`. A `null`
// return means "this phase did not decide; continue with the next phase".
// Returning a transition stops the phase list for this attempt and hands
// control back to the driver loop in runWithRecovery().

// An auth-expired / captcha / Web-API-change failure means this account's
// credentials are unusable. Retrying the same account cannot help, so cool it
// down and rotate to the next one. Returns ROTATE when another account is
// ready, otherwise a terminal 401 (or 429 when nothing is available). The
// error is re-thrown untouched if it is not an auth failure.
async function handleAuthExpired(e, deps, ctl) {
    if (!isAuthExpiredError(e)) throw e;
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountBroken(usedAccount, 'auth expired / captcha / DS Web API change');
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: 'auth expired (captcha/Web API)',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} auth expired on all ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 401,
        type: 'auth_expired',
        message: e.message || 'DS auth expired',
        allCooling,
        agentId,
        failure,
        extra: { account_attempts: ctl.accountAttempt + 1 },
    });
}

// Build the per-attempt prompts and issue the initial upstream call. Handles
// the auth-expired failure (rotate or terminate) and publishes the parsed SSE
// result onto `state`.
async function beginAttempt(state, deps, ctl) {
    const {
        agentId, agentTag, session, messages, prompt, systemPrompt,
        askDSStream, readDSResponse, fileIds, thinkingEnabled, searchEnabled,
        clientGone, deadlineHit, log,
    } = deps;

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
        initialCall = await askDSStream({ prompt: state.fullPrompt, agentId, freshSessionPrompt: state.freshPrompt, fileIds, thinkingEnabled, searchEnabled, deadlineHit, clientGone });
    } catch (e) {
        return handleAuthExpired(e, deps, ctl);
    }
    const dsResp = initialCall.resp;
    if (initialCall.promptUsed !== state.fullPrompt) {
        state.fullPrompt = initialCall.promptUsed;
    }

    const initialResult = await readDSResponse(dsResp.body, session, agentTag);
    ({ content: state.fullContent, reasoningContent: state.reasoningContent, finishReason: state.finishReason, modelError: state.modelError } = initialResult);
    // A DS `user is muted` body is account-level and lasts until mute_until:
    // retrying or rotating cannot clear it, so record it for phaseEmptyResponse
    // to park the account for the full window.
    state.muted = initialResult.muted || null;
    state.fullContent = sanitizeContent(state.fullContent);
    state.reasoningContent = sanitizeContent(state.reasoningContent || '');
    log(`${agentTag} Got ${state.fullContent.length} chars (+${state.reasoningContent.length} reasoning chars) (msg#${session.messageCount})`);
    return null;
}

// Empty-response retries on the SAME account. A client disconnect aborts the
// whole request with no error body.
async function phaseEmptyRetries(state, deps) {
    if (await runEmptyRetries(state, deps)) return terminal({ ok: false, clientGone: true });
    return null;
}

// A response with reasoning but no final content is NOT a broken account: the
// model thought but hit its token budget before emitting text. Cooling the
// account down here would (a) penalise a healthy account and (b) reproduce on
// every account with the same prompt, so ask for the final answer instead.
// Records `state.hasReasoningOnly` for phaseEmptyResponse (which must key off
// the pre-continuation state).
async function phaseReasoningOnly(state, deps) {
    const { agentTag, log } = deps;
    state.hasReasoningOnly = (!state.fullContent || state.fullContent.trim().length === 0)
        && state.reasoningContent && state.reasoningContent.trim().length > 0
        && !state.modelError;
    if (state.hasReasoningOnly) {
        log(`${agentTag} reasoning-only response (${state.reasoningContent.length} reasoning chars, 0 content); asking for the final answer.`);
        await runReasoningOnlyContinuation(state, deps);
    }
    return null;
}

// A "promised action": the model emitted reasoning and a SHORT final line
// ("Let me check the tests") but ended the turn with finish_reason=stop and no
// tool call. Neither phaseReasoningOnly (which requires an EMPTY body) nor
// runAutoContinuation (which needs finish=length or a >25k body) catches it, so
// the client is stranded until a manual "continue". Ask once for the action
// itself, bounded by maxActionPromiseContinuation.
async function phaseActionPromise(state, deps) {
    const { agentTag, clientGone, deadlineHit, log } = deps;

    // Only meaningful when the request carries tools (the promise is to call
    // one), the model did NOT already produce a call, the body is short and
    // non-empty, the model reasoned, and it stopped cleanly.
    if (!(state.allowedToolNames.size > 0
        && !state.toolCall
        && !state.modelError
        && state.finishReason === 'stop'
        && state.fullContent && state.fullContent.trim().length > 0
        && state.reasoningContent && state.reasoningContent.trim().length > 0)) {
        return null;
    }
    // Broken/truncated markup is phaseMarkupCompletion's job, not a promise.
    if (looksLikeToolCallMarkup(state.fullContent)) return null;

    const { maxActionPromiseContinuation: MAX_ACTION_PROMISE, actionPromiseMaxChars: MAX_CHARS } = currentConfig();
    if (state.fullContent.length > MAX_CHARS) return null;
    if (!looksLikeActionPromise(state.fullContent)) return null;

    let rounds = 0;
    while (!state.toolCall && rounds < MAX_ACTION_PROMISE && !clientGone() && !deadlineHit()) {
        rounds++;
        log(`${agentTag} action-promise response (${state.fullContent.length} chars, finish=stop, no tool call); asking for the action (${rounds}/${MAX_ACTION_PROMISE})...`);
        await sleep(retryDelayMs());
        const instruction = 'You described what you were about to do but did not actually do it. Now either call the appropriate tool (emit ONE valid tool_call JSON object) or, if no tool is needed, give the complete final answer. Do not promise a future action and do not repeat the plan.';
        const incrementalPrompt = appendPromptInstruction(`[Your previous response]\n${state.fullContent}`, instruction);
        const freshPrompt = appendPromptInstruction(`${state.freshPrompt}\n\n[Your previous response]\n${state.fullContent}`, instruction);
        const result = await runContinuationCall(state, deps, {
            incrementalPrompt,
            freshSessionPrompt: freshPrompt,
            label: 'action-promise',
        });
        if (!result) break;
        if (result.reasoningContent) state.reasoningContent += (state.reasoningContent ? '\n' : '') + result.reasoningContent;
        if (result.content && result.content.trim().length > 0 && !isRefusalContent(result.content)
            && !isToolResultEcho(result.content)) {
            state.fullContent = result.content;
            state.finishReason = result.finishReason;
            state.modelError = result.modelError;
            const tc = parseToolCall(result.content, () => {});
            state.toolCall = tc && state.allowedToolNames.has(tc.name) ? tc : null;
            log(`${agentTag} action-promise continuation produced ${result.content.length} chars (tool=${state.toolCall ? state.toolCall.name : 'none'})`);
            // A real final answer (no promise marker, no tool call) ends the loop.
            if (!state.toolCall && !looksLikeActionPromise(state.fullContent)) break;
        } else {
            log(`${agentTag} action-promise continuation returned nothing useful, stopping`);
            break;
        }
    }
    return null;
}

// Park a muted account until its reported mute_until and rotate. Returns a
// transition: ROTATE when another account is ready, otherwise a terminal 429.
// The mute payload is account-level and time-bound, so neither retrying the
// same account nor cooling it down for the usual short window can clear it.
async function handleMutedAccount(state, deps, ctl) {
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const untilMs = state.muted.muteUntil != null
        ? state.muted.muteUntil * 1000 - Date.now()
        : currentConfig().accountCooldownMs;
    const parkMs = Math.max(1000, untilMs);
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountBroken(usedAccount, `muted (${state.muted.message})`, parkMs);
    sessions.resetRemoteSession(session);
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: 'account muted',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} account muted after ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 429,
        type: 'rate_limit_error',
        message: allCooling
            ? 'All auth accounts are muted or cooling down. Retry later.'
            : (state.muted.message || 'DS account is muted'),
        allCooling,
        agentId,
        failure,
        extra: { mute_until: state.muted.muteUntil, account_attempts: ctl.accountAttempt + 1 },
    });
}

// A context-too-long error is deterministic and account-independent: rotating
// (or waiting out a cooldown) cannot help, and re-sending the same prompt
// reproduces it. Surface it immediately as a 400 instead of burning the
// account attempts / rotation budget.
async function terminalContextTooLong(state, deps, ctl, failureClass) {
    const { agentId, agentTag, session, log } = deps;
    log(`${agentTag} context_length_exceeded; not rotating accounts.`);
    return terminalError({
        status: failureClass.status,
        type: failureClass.type,
        message: state.modelError?.content || 'DS context length exceeded',
        agentId,
        failure: { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId },
        extra: { retry_attempts: state.retryAttempt, account_attempts: ctl.accountAttempt + 1 },
    });
}

// DS itself is briefly unavailable (finish_reason=generation_err, "Server
// temporarily unavailable."). The account is healthy, so rotating cannot
// help: every account talks to the same upstream and the next one fails
// identically. Retry the SAME account up to maxUpstreamRetries, then surface
// the error to the client without touching the account. Returns RETRY while a
// retry budget remains (same-session first, then one fresh-session attempt),
// otherwise a terminal transition.
async function handleTransientOutage(state, deps, ctl, failureClass) {
    const { agentId, agentTag, session, clientGone, deadlineHit, log } = deps;
    metrics.inc('upstreamTransient');
    if (clientGone()) return terminal({ ok: false, clientGone: true });
    // Retries are per account: reset the counter if the sticky account changed
    // since the last outage.
    if (state.upstreamRetryAccountId !== session.accountId) {
        state.upstreamRetryAccountId = session.accountId;
        state.upstreamRetryAttempt = 0;
        state.upstreamFreshRetryDone = false;
    }
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    const { maxUpstreamRetries } = currentConfig();
    if (state.upstreamRetryAttempt < maxUpstreamRetries && !deadlineHit()) {
        state.upstreamRetryAttempt++;
        log(`${agentTag} DS upstream temporarily unavailable (${state.modelError?.content || 'generation_err'}); not penalising account ${usedAccount?.id || 'n/a'}, retrying the last turn in the SAME session (${state.upstreamRetryAttempt}/${maxUpstreamRetries})...`);
        // Do NOT reset the remote session: a DS-side outage is transient and
        // the session is still valid. Retrying the last turn in place avoids
        // re-sending the full context and the extra create/delete round-trips.
        // readDSResponse() leaves parentMessageId untouched on a model error,
        // so the retry branches from the previous valid message.
        await sleep(backoffDelay(state.upstreamRetryAttempt, retryDelayMs()));
        return RETRY;
    }
    // Same-session retries are exhausted. If DS still reports the outage, try
    // once more in a FRESH remote session (full context) in case the old
    // session itself was marked bad, then give up.
    if (!state.upstreamFreshRetryDone && !deadlineHit()) {
        state.upstreamFreshRetryDone = true;
        log(`${agentTag} DS upstream temporarily unavailable after ${state.upstreamRetryAttempt} same-session retr${state.upstreamRetryAttempt === 1 ? 'y' : 'ies'}; recreating the remote session and retrying once with the full context...`);
        sessions.resetRemoteSession(session);
        await sleep(backoffDelay(state.upstreamRetryAttempt || 1, retryDelayMs()));
        return RETRY;
    }
    log(`${agentTag} DS upstream temporarily unavailable after ${state.upstreamRetryAttempt} retr${state.upstreamRetryAttempt === 1 ? 'y' : 'ies'} on account ${usedAccount?.id || 'n/a'}; giving up.`);
    return terminalError({
        status: failureClass.status,
        type: failureClass.type,
        message: state.modelError?.content || 'DS upstream temporarily unavailable',
        agentId,
        failure: { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId },
        extra: { upstream_retries: state.upstreamRetryAttempt },
    });
}

// The last line of defence: the account was penalised (short or rate-limit
// cooldown) and the request is about to rotate, or give up if nothing is
// available. Returns ROTATE when another account is ready, otherwise a
// terminal error whose status reflects whether any account is still usable.
async function terminalOrRotateRecoverable(state, deps, ctl, failureClass, timedOut, malformedCooldownMs) {
    const { agentId, agentTag, session, clientGone, rotationDeadlineHit, log } = deps;
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    if (state.modelError?.type === 'rate_limit' || state.modelError?.finish_reason === 'rate_limit_reached') {
        accounts.markAccountFailure(usedAccount, 429, 'rate-limit-empty-response');
    } else {
        // An empty/malformed stream is usually a transient model or protocol
        // glitch, NOT a dead account. Use the short recoverable-failure cooldown
        // (same as malformed tool markup) instead of the long accountCooldownMs,
        // otherwise a single upstream protocol change parks every account for
        // minutes.
        accounts.markAccountBroken(usedAccount, `empty response (${failureClass.type})`, malformedCooldownMs);
    }
    // `waitForAvailableAccount` returns the *current* availability, so a single
    // call covers both the immediate and the wait-then-check cases.
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: failureClass.type,
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const errorType = failureClass.type;
    const errorMessage = state.modelError?.content
        || (timedOut
            ? 'DS request deadline reached while recovering an empty response'
            : `DS returned empty content after ${state.retryAttempt} retr${state.retryAttempt === 1 ? 'y' : 'ies'}`);
    log(`${agentTag} ${errorType} after ${state.retryAttempt} retr${state.retryAttempt === 1 ? 'y' : 'ies'} and ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    const allCooling = !accounts.hasAvailableAccount();
    return terminalError({
        status: failureClass.status,
        type: errorType,
        message: errorMessage,
        allCooling,
        agentId,
        failure,
        extra: {
            retry_attempts: state.retryAttempt,
            account_attempts: ctl.accountAttempt + 1,
            upstream_prompt_chars: state.fullPrompt.length,
        },
    });
}

// The response is still empty after the same-account retries and the
// reasoning-only continuation. Classify the failure and either retry the same
// account (transient DS outage), rotate, or terminate.
async function phaseEmptyResponse(state, deps, ctl) {
    const { deadlineHit, malformedCooldownMs } = deps;

    if (!((!state.fullContent || state.fullContent.trim().length === 0) && !state.hasReasoningOnly)) return null;

    // One empty-response recovery reached terminal classification. Counted here
    // (not per same-account retry) so the metric means "requests that ended
    // empty", not "retries burned".
    metrics.inc('emptyResponses');
    const timedOut = deadlineHit();
    const failureClass = classifyRecoveryFailure(state.modelError, timedOut);

    // DS returned a `user is muted` payload instead of a stream. This is
    // account-level and lasts until mute_until: retrying or rotating cannot
    // clear it, so park the account for the whole window and move on. The
    // session is reset because the muted turn was never accepted upstream.
    if (state.muted) return handleMutedAccount(state, deps, ctl);

    if (failureClass.type === 'context_length_exceeded') {
        return terminalContextTooLong(state, deps, ctl, failureClass);
    }
    if (isUpstreamTransientError(state.modelError)) {
        return handleTransientOutage(state, deps, ctl, failureClass);
    }
    return terminalOrRotateRecoverable(state, deps, ctl, failureClass, timedOut, malformedCooldownMs);
}

// Auto-continuation for long / length-finished responses.
async function phaseAutoContinuation(state, deps) {
    await runAutoContinuation(state, deps);
    return null;
}

// Tool-call extraction. A parsed call whose name is not in `allowedToolNames`
// is NOT broken markup — the JSON was valid, the model just asked for a tool
// we don't expose. It is recorded in `state.unknownToolName` (so
// phaseUnknownTool can ask once for a valid name) and dropped from
// `state.toolCall` here, rather than being routed to the session-reset /
// account-rotation path (which cannot help: a hallucinated name is
// deterministic and rotates healthy accounts for nothing).
async function phaseToolExtraction(state, deps) {
    const { tools } = deps;
    state.allowedToolNames = new Set(tools
        .filter(tool => tool?.type === 'function' && tool.function?.name)
        .map(tool => tool.function.name));
    const parsed = state.allowedToolNames.size > 0
        ? memoizeParse(state, 'call', state.fullContent, parseToolCall)
        : null;
    if (parsed && !state.allowedToolNames.has(parsed.name)) {
        state.unknownToolName = parsed.name;
        state.toolCall = null;
    } else {
        state.toolCall = parsed;
    }
    return null;
}

// One corrective retry for an unknown tool name. Deterministic failure, so
// this never rotates accounts and never resets the session: it re-prompts in
// the SAME remote session with the list of available tool names. On success
// `state.toolCall` is set and the caller proceeds normally; on failure it
// returns a terminal `unknown_tool` error instead of leaking the raw markup to
// the client as text (which would strand the consuming agent).
async function phaseUnknownTool(state, deps) {
    const {
        agentId, agentTag, session, askDSStream, readDSResponse,
        clientGone, deadlineHit, log,
    } = deps;
    if (!state.unknownToolName || state.toolCall) return null;

    const { maxUnknownToolRetries: MAX_UNKNOWN_TOOL_RETRIES } = currentConfig();
    const available = [...state.allowedToolNames];
    while (state.unknownToolRetryAttempt < MAX_UNKNOWN_TOOL_RETRIES && !clientGone() && !deadlineHit()) {
        state.unknownToolRetryAttempt++;
        log(`${agentTag} Unknown tool "${state.unknownToolName}" requested; re-prompting for a valid name (${state.unknownToolRetryAttempt}/${MAX_UNKNOWN_TOOL_RETRIES})...`);
        await sleep(retryDelayMs());
        const retryPrompt = appendPromptInstruction(
            state.freshPrompt,
            `Your previous response requested the tool "${state.unknownToolName}", which is not available. Use ONLY one of these tools: ${available.join(', ')}. Emit ONE valid tool_call JSON object; do not invent tool names.`
        );
        const retryCall = await askDSStream({ prompt: retryPrompt, agentId, freshSessionPrompt: retryPrompt, fileIds: deps.fileIds, thinkingEnabled: deps.thinkingEnabled, searchEnabled: deps.searchEnabled, deadlineHit, clientGone });
        const retryResult = await readDSResponse(retryCall.resp.body, session, agentTag);
        const retryContent = retryResult && retryResult.content ? sanitizeContent(retryResult.content) : '';
        if (retryContent && retryContent.trim()) {
            const retryTc = parseToolCall(retryContent);
            if (retryTc && state.allowedToolNames.has(retryTc.name)) {
                log(`${agentTag} Corrective retry succeeded: ${retryTc.name}`);
                state.fullContent = retryContent;
                state.reasoningContent = retryResult.reasoningContent ? sanitizeContent(retryResult.reasoningContent) : '';
                state.finishReason = retryResult.finishReason;
                state.toolCall = retryTc;
                state.unknownToolName = null;
                return null;
            }
            // The retry produced content but still no valid call. Keep the new
            // content for diagnostics and, if it names a *different* unknown
            // tool, carry that name into the next round's prompt; otherwise
            // fall through to the terminal error so the raw markup is not
            // leaked as text.
            if (retryTc && retryTc.name && retryTc.name !== state.unknownToolName) {
                log(`${agentTag} Corrective retry picked another unavailable tool "${retryTc.name}".`);
                state.unknownToolName = retryTc.name;
            }
            state.fullContent = retryContent;
            if (retryResult.reasoningContent) state.reasoningContent = sanitizeContent(retryResult.reasoningContent);
            state.finishReason = retryResult.finishReason;
        }
    }

    log(`${agentTag} Unknown tool "${state.unknownToolName}" after ${state.unknownToolRetryAttempt} corrective retr${state.unknownToolRetryAttempt === 1 ? 'y' : 'ies'}; giving up without rotating accounts.`);
    metrics.inc('unknownTool');
    return terminalError({
        status: 502,
        type: 'unknown_tool',
        message: `Model requested unavailable tool "${state.unknownToolName}" and did not pick a valid one after ${state.unknownToolRetryAttempt} corrective retr${state.unknownToolRetryAttempt === 1 ? 'y' : 'ies'}`,
        agentId,
        failure: { failedSessionId: session.id, failedMessageCount: session.messageCount, accountId: session.accountId },
        extra: {
            requested_tool: state.unknownToolName,
            available_tools: available,
            retry_attempts: state.unknownToolRetryAttempt,
        },
    });
}

// Ask the model to finish truncated tool-call markup (up to
// maxMarkupCompletion rounds).
async function phaseMarkupCompletion(state, deps) {
    await runMarkupCompletion(state, deps);
    return null;
}

// One strict retry with the fresh prompt when the markup is still truncated.
async function phaseStrictRetry(state, deps) {
    await runStrictToolRetry(state, deps);
    return null;
}

// Irreparably broken tool markup. A malformed tool call is usually a bad remote
// session, not a dead account, so recreate the session on the SAME account
// first and only rotate after `maxSessionResetsPerAccount` consecutive resets.
async function phaseBrokenMarkup(state, deps, ctl) {
    const {
        agentId, agentTag, session, malformedCooldownMs,
        clientGone, rotationDeadlineHit, log,
    } = deps;

    // Parse once here (the content may have changed in the completion/retry
    // passes above) and reuse it.
    const hasBrokenToolMarkup = state.allowedToolNames.size > 0
        && !state.toolCall
        && looksLikeToolCallMarkup(state.fullContent)
        && memoizeParse(state, 'call', state.fullContent, parseToolCall) === null;
    if (!hasBrokenToolMarkup) return null;

    const maxSessionResetsPerAccount = ctl.maxSessionResetsPerAccount;
    session.malformedResets = (session.malformedResets || 0) + 1;
    if (session.malformedResets < maxSessionResetsPerAccount) {
        log(`${agentTag} Broken tool markup (session reset ${session.malformedResets}/${maxSessionResetsPerAccount}); recreating remote session on the same account.`);
        sessions.resetRemoteSession(session);
        await sleep(backoffDelay(session.malformedResets, retryDelayMs()));
        return RETRY;
    }
    session.malformedResets = 0;
    const usedAccount = accounts.getAccounts().find(a => a.id === session.accountId);
    accounts.markAccountBroken(usedAccount, 'malformed tool-call markup', malformedCooldownMs);
    const { failure, rotated } = await rotateAccountAfterFailure({
        session, accountAttempt: ctl.accountAttempt, agentTag, reason: 'malformed tool-call markup',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} Broken tool markup; recreating remote session.`);
    metrics.inc('malformedToolCalls');
    return terminalError({
        status: 502,
        type: 'malformed_tool_call',
        message: allCooling
            ? 'All auth accounts are cooling down after repeated malformed tool-call markup. Retry later.'
            : 'DS returned malformed tool-call markup after one repair attempt',
        allCooling,
        agentId,
        failure,
        extra: { session_preserved: false, account_attempts: ctl.accountAttempt + 1 },
    });
}

// The ordered recovery phases for a single account attempt. The driver re-runs
// this whole list on RETRY/ROTATE; a fully successful pass returns SUCCESS.
const RECOVERY_PHASES = [
    beginAttempt,
    phaseEmptyRetries,
    phaseReasoningOnly,
    phaseEmptyResponse,
    phaseAutoContinuation,
    phaseToolExtraction,
    phaseUnknownTool,
    // Runs AFTER phaseToolExtraction/phaseUnknownTool so state.allowedToolNames
    // is populated and any valid/unknown call has already been decided, and
    // BEFORE the markup phases so a genuinely truncated call is repaired by
    // phaseMarkupCompletion rather than mistaken for a promise (the
    // looksLikeToolCallMarkup guard below enforces that).
    phaseActionPromise,
    phaseMarkupCompletion,
    phaseStrictRetry,
    phaseBrokenMarkup,
];

// Run one account attempt: execute the phases in order until one returns a
// transition. Returns a transition (SUCCESS when every phase passed).
async function runRecoveryAttempt(state, deps, ctl) {
    for (const phase of RECOVERY_PHASES) {
        const transition = await phase(state, deps, ctl);
        if (transition) return transition;
    }
    return SUCCESS;
}

// Post-process a successful recovery run and build the caller-facing result:
// apply OpenAI `stop` truncation, inject MEDIA screenshot paths, clear the
// malformed-markup counter, and mark the turns that reached the remote session.
// Mutates `state`/`session` in place; the return value is the `ok:true` result.
function finalizeSuccess(state, deps) {
    const { agentTag, session, messages, stop, log } = deps;

    // OpenAI `stop` sequences: truncate the visible answer at the earliest
    // stop string (and drop everything after it). DS has no native stop
    // support, so this is applied locally to the assembled content. A tool call
    // is left untouched — truncating its JSON would corrupt it.
    if (!state.toolCall && Array.isArray(stop) && stop.length > 0 && state.fullContent) {
        let cut = -1;
        for (const s of stop) {
            if (!s) continue;
            const pos = state.fullContent.indexOf(s);
            if (pos !== -1 && (cut === -1 || pos < cut)) cut = pos;
        }
        if (cut !== -1) {
            state.fullContent = state.fullContent.slice(0, cut);
            log(`${agentTag} stop sequence matched; truncated response to ${cut} chars`);
        }
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
        searchEnabled = undefined,
        stop = [],
        maxEmptyRetries,
        malformedCooldownMs,
        // callbacks
        clientGone = () => false,
        deadlineHit = () => false,
        log = console.log,
    } = ctx;

    const maxAccountAttempts = Math.max(1, accounts.getAccounts().length);
    const maxSessionResetsPerAccount = Math.max(1, currentConfig().maxSessionResetsPerAccount);

    // Rotation gets its own wall-clock budget so a request does not spend its
    // entire requestDeadlineMs waiting out cooldowns account after account. Once
    // this elapses, rotateAccountAfterFailure() stops waiting and the phase
    // reports a terminal error using the last failure snapshot.
    const rotationStartedAt = Date.now();
    const rotationBudgetMs = currentConfig().rotationBudgetMs;
    // Stop rotating once EITHER the overall request deadline is hit or the
    // dedicated rotation budget elapses. The request deadline still wins, so
    // callers that pass deadlineHit=()=>true (tests, or a request already out
    // of time) see rotation stop immediately as before.
    const rotationDeadlineHit = () => deadlineHit() || Date.now() - rotationStartedAt > rotationBudgetMs;

    // Mutable per-request state shared by the recovery phases. Each phase
    // mutates the fields it owns and reads the rest.
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
        // Set by phaseToolExtraction when the model parsed a call whose name is
        // not in allowedToolNames. phaseUnknownTool consumes it for one
        // corrective retry, then clears it (or returns a terminal error).
        unknownToolName: null,
        unknownToolRetryAttempt: 0,
        retryAttempt: 0,
        // Set by beginAttempt/runEmptyRetries when the upstream body is a DS
        // `user is muted` payload; phaseEmptyResponse parks the account until
        // the reported mute_until instead of the usual short cooldown.
        muted: null,
        // Set by phaseReasoningOnly: the pre-continuation reasoning-only flag.
        hasReasoningOnly: false,
        // Same-account retries already spent on a transient DS upstream outage,
        // plus the account they belong to (a rotation resets the counter).
        upstreamRetryAttempt: 0,
        upstreamRetryAccountId: null,
        // Once the same-session retries above are exhausted, one last attempt is
        // made in a FRESH remote session (full context) in case DS marked the
        // old session bad. This flag makes that happen at most once per account.
        upstreamFreshRetryDone: false,
    };

    // Read-only dependencies shared by the phases.
    const deps = {
        agentId, agentTag, session, messages, tools, prompt, systemPrompt,
        askDSStream, readDSResponse, fileIds, thinkingEnabled, searchEnabled, stop,
        maxEmptyRetries, malformedCooldownMs, clientGone, deadlineHit, rotationDeadlineHit, log,
    };

    // Driver: each iteration runs the phase list once for the current account.
    // RETRY re-runs it on the same account; ROTATE advances the account counter;
    // SUCCESS leaves the loop to finalize; a terminal transition is returned
    // immediately. If the account budget is exhausted before SUCCESS, the loop
    // ends with `succeeded` still false and the block below reports a terminal
    // error instead of returning an empty completion as ok:true.
    let accountAttempt = 0;
    let succeeded = false;
    while (accountAttempt < maxAccountAttempts) {
        const ctl = { accountAttempt, maxAccountAttempts, maxSessionResetsPerAccount };
        const transition = await runRecoveryAttempt(state, deps, ctl);
        if (transition.kind === 'success') { succeeded = true; break; }
        if (transition.kind === 'retry') continue;
        if (transition.kind === 'rotate') { accountAttempt++; continue; }
        return transition.result;
    }

    // The loop can exit without a SUCCESS when the last attempt returned ROTATE
    // but the account budget was already spent (accountAttempt reached
    // maxAccountAttempts). `state` is then whatever the final failed attempt
    // left behind -- usually an empty body. Returning it as ok:true would hand
    // the client an empty completion, so report a terminal error instead. The
    // status mirrors the all-cooling branch in phaseEmptyResponse: 429 when no
    // account is available, otherwise 502.
    if (!succeeded) {
        const allCooling = !accounts.hasAvailableAccount();
        log(`${agentTag} account attempts exhausted (${maxAccountAttempts}) without a usable response. Giving up.`);
        return { ok: false, error: {
            status: allCooling ? 429 : 502,
            body: {
                message: allCooling
                    ? 'All auth accounts are cooling down after repeated recoverable failures. Retry later.'
                    : 'DS returned no usable response after exhausting all account attempts.',
                type: allCooling ? 'rate_limit_error' : (state.modelError?.type || 'empty_response'),
                agent: agentId,
                failed_session_id: session.id,
                message_count: session.messageCount,
                account: session.accountId,
                retry_attempts: state.retryAttempt,
                account_attempts: maxAccountAttempts,
            },
        } };
    }

    return finalizeSuccess(state, deps);
}

module.exports = {
    backoffDelay,
    rotateAccountAfterFailure,
    runWithRecovery,
};
