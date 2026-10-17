'use strict';
// Continuation passes shared by the recovery phases: the account-affinity-safe
// upstream call wrapper plus the auto-continue / reasoning-only / empty-retry
// loops. Extracted from recovery.js so the phase driver stays readable; every
// function here mutates the shared `state` in place and reads `deps`.

const {
    sanitizeContent,
    isContinuationRecoverySafe,
    isRefusalContent,
    isToolResultEcho,
    stripToolResultEchoes,
    normalizeRetryResponse,
    isContextTooLongError,
} = require('./recovery-classify');
const { composePrompt, appendPromptInstruction } = require('./prompt');
const sessions = require('./sessions');
const { currentConfig, retryDelayMs, sleep, backoffDelay } = require('./recovery-util');

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
        content: raw && raw.content ? stripToolResultEchoes(sanitizeContent(raw.content)) : '',
        reasoningContent: raw && raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : '',
        finishReason: raw && raw.finishReason,
        modelError: (raw && raw.modelError) || null,
        raw,
    };
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

module.exports = {
    runContinuationCall,
    runEmptyRetries,
    runAutoContinuation,
    runReasoningOnlyContinuation,
};
