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
// named, individually reviewable functions and returning them as pure data
// keeps the control flow visible at the call site instead of hidden in inline
// jumps.

const {
    sanitizeContent,
    isToolResultEcho,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    looksLikeActionPromise,
} = require('./recovery-classify');
const {
    composePrompt,
    collectPendingTurns,
    markTurnsSent,
    formatPendingTurns,
    extractScreenshotPaths,
    toolQualifiedName,
} = require('./prompt');

const { parseToolCall, looksLikeToolCallMarkup } = require('./parser');
const accounts = require('./accounts');

// Read recovery knobs at call time (not a load-time snapshot), matching the
// request path in handlers.js. The exported constants below are a load-time
// snapshot kept for back-compat with tests that import them.
const { currentConfig, backoffDelay, memoizeParse } = require('./recovery-util');
const { RETRY, ROTATE, SUCCESS, terminalError, rotateAccountAfterFailure } = require('./recovery-transitions');
const { runAutoContinuation } = require('./recovery-continuation');
const { handleAuthExpired, handleMutedAccount, terminalContextTooLong, handleTransientOutage, terminalOrRotateRecoverable } = require('./recovery-failures');
const metrics = require('./metrics');

// Each phase is `async (state, deps, ctl) -> transition | null`. A `null`
// return means "this phase did not decide; continue with the next phase".
// Returning a transition stops the phase list for this attempt and hands
// control back to the driver loop in runWithRecovery().

// Build the per-attempt prompts and issue the initial upstream call. Handles
// the auth-expired failure (rotate or terminate) and publishes the parsed SSE
// result onto `state`.
async function beginAttempt(state, deps, ctl) {
    const {
        agentId, agentTag, session, messages, prompt, systemPrompt,
        askDSStream, readDSResponse, fileIds, thinkingEnabled, searchEnabled,
        clientGone, deadlineHit, log,
    } = deps;

    // When a remote DS session already exists AND has accepted at least one
    // turn, only forward the turns it has not seen yet. The system prompt
    // (tool definitions included) travels only with a session's first
    // message, so a session that exists but has never accepted a turn (its
    // creation succeeded, the completion failed) must be treated as fresh:
    // its delta-only prompt would never carry the tool definitions and the
    // model would answer as if no tools were available.
    state.reusingRemoteSession = Boolean(session.id) && session.messageCount > 0;
    // On a fresh session every user/tool turn is still pending, so the same
    // helper yields the full history; logging it keeps turn 1 and follow-up
    // turns symmetric instead of going silent on the first call.
    state.pendingTurns = collectPendingTurns(messages, session);
    const incrementalPrompt = state.pendingTurns.length > 0 ? formatPendingTurns(state.pendingTurns) : '';

    const conversationPrompt = state.reusingRemoteSession
        ? (incrementalPrompt || prompt)
        : prompt;

    state.fullPrompt = state.reusingRemoteSession
        ? composePrompt('', conversationPrompt)
        : composePrompt(systemPrompt, conversationPrompt);
    state.freshPrompt = composePrompt(systemPrompt, prompt);
    log(`${agentTag} Incremental prompt: ${state.pendingTurns.length} pending turn(s), ${incrementalPrompt.length} chars (full conversation would be ${prompt.length} chars)`);

    let initialCall;
    try {
        initialCall = await askDSStream({ prompt: state.fullPrompt, agentId, freshSessionPrompt: state.freshPrompt, fileIds, thinkingEnabled: thinkingEnabled && !state.disableThinking, searchEnabled, deadlineHit, clientGone });
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

// The model sometimes imitates the harness tool-result envelope
// (<tool_result>...</tool_result>, the format prompt.renderTurn uses for
// role:'tool' messages going IN) in its own output. Emitting it back is
// always a fabrication: the envelope is produced by the client from real tool
// output, never by the model. The imitation is deterministic for this
// account+session, so re-prompting or stripping it only wastes the turn; drop
// the account and rotate instead. No cooldown -- the same prompt may work on
// another account.
async function phaseToolResultEcho(state, deps, ctl) {
    const { agentTag, clientGone, rotationDeadlineHit, log } = deps;
    if (!state.fullContent || !isToolResultEcho(state.fullContent)) return null;

    metrics.inc('toolResultEcho');
    const { failure, rotated } = await rotateAccountAfterFailure({
        session: deps.session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: 'fabricated tool-result envelope',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} fabricated tool-result envelope on all ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 502,
        type: 'tool_result_echo',
        message: 'Model imitated the harness tool-result envelope; no other account available.',
        allCooling,
        agentId: deps.agentId,
        failure,
        extra: { account_attempts: ctl.accountAttempt + 1 },
    });
}

// A response with reasoning but no final content is not a broken account: the
// model thought but hit its token budget before emitting text. Re-prompting
// only wastes the turn (the same prompt tends to reproduce it), so drop the
// account and rotate. No cooldown -- the same prompt may work elsewhere.
async function phaseReasoningOnly(state, deps, ctl) {
    const { agentId, agentTag, clientGone, rotationDeadlineHit, log } = deps;
    const reasoningOnly = (!state.fullContent || state.fullContent.trim().length === 0)
        && state.reasoningContent && state.reasoningContent.trim().length > 0
        && !state.modelError;
    if (!reasoningOnly) return null;

    const { failure, rotated } = await rotateAccountAfterFailure({
        session: deps.session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: 'reasoning-only response (no visible answer)',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} reasoning-only response on all ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 502,
        type: 'reasoning_only',
        message: 'Model produced reasoning but no visible answer; no other account available.',
        allCooling,
        agentId,
        failure,
        extra: { account_attempts: ctl.accountAttempt + 1 },
    });
}

// DS aborts a tool-calling turn in thinking mode: the stream delivers THINK
// fragments up to the point where the model is about to emit its tool call,
// then ends with generation_err and no content. Retrying with identical
// settings reproduces it deterministically. Spend one attempt with thinking
// disabled (the request still carries tools) before the generic transient
// outage path starts burning same-session retries.
async function phaseThinkingToolFallback(state, deps) {
    const { agentTag, tools, thinkingEnabled, log } = deps;
    if (state.thinkingFallbackDone || state.disableThinking) return null;
    if (!thinkingEnabled) return null;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    if (!isUpstreamTransientError(state.modelError)) return null;
    if (!state.reasoningContent || !state.reasoningContent.trim()) return null;
    if (state.fullContent && state.fullContent.trim()) return null;

    state.thinkingFallbackDone = true;
    state.disableThinking = true;
    metrics.inc('thinkingFallbacks');
    log(`${agentTag} DS aborted a tool-call turn after reasoning (${state.modelError?.finish_reason || 'generation_err'}); retrying once with thinking disabled.`);
    return RETRY;
}

// A "promised action": the model emitted reasoning and a SHORT final line
// ("Let me check the tests") but ended the turn cleanly with no tool call.
// Neither phaseReasoningOnly (which requires an EMPTY body) nor
// runAutoContinuation (which needs finish=length or a >25k body) catches it, so
// the client used to be stranded until a manual "continue". The promise is
// deterministic for this account+session, so re-prompting only wastes the turn;
// drop the account and rotate. No cooldown -- the same prompt may work elsewhere.
async function phaseActionPromise(state, deps, ctl) {
    const { agentId, agentTag, clientGone, rotationDeadlineHit, log } = deps;

    // Only meaningful when the request carries tools (the promise is to call
    // one), the model did NOT already produce a call, the body is short and
    // non-empty, the model reasoned, and the turn ended cleanly. A clean end
    // is either the legacy 'stop' or a null finish reason: DS's current flow
    // finishes via `response/status: FINISHED` and never sends
    // `response/finish_reason`, so requiring 'stop' alone kept this phase dead.
    if (!(state.allowedToolNames.size > 0
        && !state.toolCall
        && !state.modelError
        && (state.finishReason === 'stop' || state.finishReason == null)
        && state.fullContent && state.fullContent.trim().length > 0
        && state.reasoningContent && state.reasoningContent.trim().length > 0)) {
        return null;
    }
    // Broken/truncated markup is phaseBrokenMarkup's job, not a promise.
    if (looksLikeToolCallMarkup(state.fullContent)) return null;

    const { actionPromiseMaxChars: MAX_CHARS } = currentConfig();
    if (state.fullContent.length > MAX_CHARS) return null;
    if (!looksLikeActionPromise(state.fullContent)) return null;

    const { failure, rotated } = await rotateAccountAfterFailure({
        session: deps.session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: 'action-promise response (no tool call)',
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} action-promise response on all ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    return terminalError({
        status: 502,
        type: 'action_promise',
        message: 'Model promised an action without calling a tool; no other account available.',
        allCooling,
        agentId,
        failure,
        extra: { account_attempts: ctl.accountAttempt + 1 },
    });
}

// The response is still empty after the same-account retries. Classify the
// failure and either retry the same account (transient DS outage), rotate, or
// terminate.
async function phaseEmptyResponse(state, deps, ctl) {
    const { deadlineHit } = deps;

    if (!(!state.fullContent || state.fullContent.trim().length === 0)) return null;

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
    return terminalOrRotateRecoverable(state, deps, ctl, failureClass, timedOut);
}

// Auto-continuation for long / length-finished responses.
async function phaseAutoContinuation(state, deps) {
    await runAutoContinuation(state, deps);
    return null;
}

// Tool-call extraction. A parsed call whose name is not in `allowedToolNames`
// is NOT broken markup — the JSON was valid, the model just asked for a tool
// we don't expose. It is recorded in `state.unknownToolName` (so
// phaseUnknownTool can rotate the account) and dropped from `state.toolCall`
// here, so the raw markup is never leaked to the client as text.
async function phaseToolExtraction(state, deps) {
    const { tools } = deps;
    state.allowedToolNames = new Set(tools
        .filter(tool => tool?.type === 'function' && tool.function?.name)
        .map(tool => toolQualifiedName(tool)));
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

// A parsed call whose name is not in `allowedToolNames`. The JSON was valid,
// the model just asked for a tool we don't expose. A hallucinated name is
// deterministic for this account+session, so re-prompting only wastes the turn
// (and would leak the raw markup if it were emitted as text); drop the account
// and rotate. No cooldown -- the same prompt may work elsewhere.
async function phaseUnknownTool(state, deps, ctl) {
    const { agentId, agentTag, clientGone, rotationDeadlineHit, log } = deps;
    if (!state.unknownToolName || state.toolCall) return null;

    const { failure, rotated } = await rotateAccountAfterFailure({
        session: deps.session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: `unavailable tool "${state.unknownToolName}" requested`,
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    log(`${agentTag} unavailable tool "${state.unknownToolName}" on all ${ctl.accountAttempt + 1} account attempt(s). Giving up.`);
    metrics.inc('unknownTool');
    return terminalError({
        status: 502,
        type: 'unknown_tool',
        message: `Model requested unavailable tool "${state.unknownToolName}"; no other account available.`,
        allCooling,
        agentId,
        failure,
        extra: {
            requested_tool: state.unknownToolName,
            available_tools: [...state.allowedToolNames],
            account_attempts: ctl.accountAttempt + 1,
        },
    });
}

// Irreparably broken tool markup. Rotate immediately: a retry on the same
// account keeps reproducing the same malformed body, and recreating the session
// first would just burn an extra create/delete round-trip.
async function phaseBrokenMarkup(state, deps, ctl) {
    const {
        agentId, agentTag, session,
        clientGone, rotationDeadlineHit, log,
    } = deps;

    // Parse once here (the content may have changed in the completion/retry
    // passes above) and reuse it.
    const hasBrokenToolMarkup = state.allowedToolNames.size > 0
        && !state.toolCall
        && looksLikeToolCallMarkup(state.fullContent)
        && memoizeParse(state, 'call', state.fullContent, parseToolCall) === null;
    if (!hasBrokenToolMarkup) return null;

    log(`${agentTag} Broken tool markup; rotating account without a cooldown.`);
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
    // Must run BEFORE the empty-retry and extraction phases: a fabricated
    // tool-result envelope is the client format and must neither reach
    // the client nor be parsed as a real tool call.
    phaseToolResultEcho,
    phaseReasoningOnly,
    // Before the generic empty/transient path: a generation_err that arrived
    // after tool-intent reasoning is deterministic with thinking on, so spend
    // one attempt with thinking disabled instead of replaying the same request.
    phaseThinkingToolFallback,
    phaseEmptyResponse,
    phaseAutoContinuation,
    phaseToolExtraction,
    phaseUnknownTool,
    // Runs AFTER phaseToolExtraction/phaseUnknownTool so state.allowedToolNames
    // is populated and any valid/unknown call has already been decided, and
    // BEFORE the markup phases so a genuinely truncated call is repaired by
    // phaseBrokenMarkup rather than mistaken for a promise (the
    // looksLikeToolCallMarkup guard below enforces that).
    phaseActionPromise,
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
        // callbacks
        clientGone = () => false,
        deadlineHit = () => false,
        log = console.log,
    } = ctx;

    const maxAccountAttempts = Math.max(1, accounts.getAccounts().length);

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
        // not in allowedToolNames. phaseUnknownTool consumes it to rotate the
        // account (or returns a terminal error when no account is available).
        unknownToolName: null,
        retryAttempt: 0,
        // Set by beginAttempt when the upstream body is a DS `user is muted`
        // payload; phaseEmptyResponse parks the account until the reported
        // mute_until instead of the usual short cooldown.
        muted: null,
        // Same-account retries already spent on a transient DS upstream outage,
        // plus the account they belong to (a rotation resets the counter).
        upstreamRetryAttempt: 0,
        upstreamRetryAccountId: null,
        // Once the same-session retries above are exhausted, one last attempt is
        // made in a FRESH remote session (full context) in case DS marked the
        // old session bad. This flag makes that happen at most once per account.
        upstreamFreshRetryDone: false,
        // Set by phaseThinkingToolFallback: the next upstream call omits
        // thinking so a tool-calling turn DS aborts in thinking mode can still
        // complete. Sticky for the rest of the request.
        disableThinking: false,
        thinkingFallbackDone: false,
    };

    // Read-only dependencies shared by the phases.
    const deps = {
        agentId, agentTag, session, messages, tools, prompt, systemPrompt,
        askDSStream, readDSResponse, fileIds, thinkingEnabled, searchEnabled, stop,
        clientGone, deadlineHit, rotationDeadlineHit, log,
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
        const ctl = { accountAttempt, maxAccountAttempts };
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
