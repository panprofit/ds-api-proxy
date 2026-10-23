'use strict';

const {
    sanitizeContent,
    isContinuationRecoverySafe,
    isRefusalContent,
    isToolResultEcho,
    stripToolResultEchoes,
} = require('./recovery-classify');
const { appendPromptInstruction } = require('./prompt');
const sessions = require('./sessions');
const { currentConfig, retryBaseMs, sleep } = require('./recovery-util');

async function runContinuationCall(state, deps, { incrementalPrompt, freshSessionPrompt, label }) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, clientGone, log } = deps;
    const beforeId = session.accountId;
    const call = await askDSStream({
        prompt: incrementalPrompt, agentId,
        freshSessionPrompt,
        fileIds: state.fileIds,
        fileIdsAccountId: state.fileIdsAccountId,
        resolveFileIds: deps.resolveFileIds,
        thinkingEnabled: deps.thinkingEnabled,
        searchEnabled: deps.searchEnabled,
        clientGone,
        abortSignal: deps.abortSignal,
    });
    if (call.fileIds) {
        state.fileIds = call.fileIds;
        state.fileIdsAccountId = call.fileIdsAccountId ?? state.fileIdsAccountId;
    }
    if (!isContinuationRecoverySafe(beforeId, call)) {
        log(`${agentTag} ${label} continuation rotated account; skipping`);
        sessions.resetRemoteSession(session);
        return null;
    }
    const raw = await readDSResponse(call.resp.body, session, agentTag, { onReasoningDelta: deps.onReasoningDelta });
    return {
        content: raw && raw.content ? stripToolResultEchoes(sanitizeContent(raw.content)) : '',
        reasoningContent: raw && raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : '',
        finishReason: raw && raw.finishReason,
        modelError: (raw && raw.modelError) || null,
        raw,
    };
}

async function continueReasoningOnly(state, deps) {
    const { agentTag, clientGone, log } = deps;
    if (clientGone()) return false;

    const freshSessionPrompt = appendPromptInstruction(
        state.freshPrompt,
        'Your previous turn ended after the reasoning step without a visible answer. '
        + 'Provide the final answer now. Do not repeat the reasoning.'
    );
    log(`${agentTag} Reasoning-only response; asking the same session to continue...`);
    let cont;
    try {
        cont = await runContinuationCall(state, deps, {
            incrementalPrompt: 'continue',
            freshSessionPrompt,
            label: 'reasoning-only',
        });
    } catch (e) {
        log(`${agentTag} Reasoning-only continuation failed (${e && e.message ? e.message : e}); falling back`);
        return false;
    }
    if (!cont) return false;

    if (cont.content && cont.content.trim().length > 0
        && !isRefusalContent(cont.content) && !isToolResultEcho(cont.content)) {
        state.fullContent = state.fullContent ? `${state.fullContent}\n${cont.content}` : cont.content;
        if (cont.reasoningContent) state.reasoningContent += (state.reasoningContent ? '\n' : '') + cont.reasoningContent;
        state.finishReason = cont.finishReason;
        state.modelError = cont.modelError || null;
        log(`${agentTag} Reasoning-only continuation added ${cont.content.length} chars (total: ${state.fullContent.length})`);
        return true;
    }

    log(`${agentTag} Reasoning-only continuation produced no visible content`);
    if (cont.reasoningContent) state.reasoningContent += (state.reasoningContent ? '\n' : '') + cont.reasoningContent;
    state.finishReason = cont.finishReason ?? state.finishReason;
    state.modelError = cont.modelError || state.modelError;
    return false;
}

async function runAutoContinuation(state, deps) {
    const { agentTag, clientGone, log } = deps;

    const { maxContinuation: MAX_CONTINUATION, continuationSizeThreshold: CONTINUATION_SIZE_THRESHOLD } = currentConfig();
    let continuationRounds = 0;

    while (state.fullContent.length > 0
        && (state.finishReason === 'length' || state.fullContent.length > CONTINUATION_SIZE_THRESHOLD)
        && continuationRounds < MAX_CONTINUATION) {
        if (clientGone()) break;
        continuationRounds++;
        log(`${agentTag} Response ${state.fullContent.length} chars (finish=${state.finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
        await sleep(retryBaseMs());
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

module.exports = {
    continueReasoningOnly,
    runAutoContinuation,
};
