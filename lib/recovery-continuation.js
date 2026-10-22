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
const { currentConfig, retryDelayMs, sleep } = require('./recovery-util');

async function runContinuationCall(state, deps, { incrementalPrompt, freshSessionPrompt, label }) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, clientGone, deadlineHit, log } = deps;
    const beforeId = session.accountId;
    const call = await askDSStream({
        prompt: incrementalPrompt, agentId,
        freshSessionPrompt,
        fileIds: state.fileIds,
        fileIdsAccountId: state.fileIdsAccountId,
        resolveFileIds: deps.resolveFileIds,
        thinkingEnabled: deps.thinkingEnabled && !state.disableThinking,
        searchEnabled: deps.searchEnabled,
        deadlineHit, clientGone,
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
    const raw = await readDSResponse(call.resp.body, session, agentTag);
    return {
        content: raw && raw.content ? stripToolResultEchoes(sanitizeContent(raw.content)) : '',
        reasoningContent: raw && raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : '',
        finishReason: raw && raw.finishReason,
        modelError: (raw && raw.modelError) || null,
        raw,
    };
}

async function runAutoContinuation(state, deps) {
    const { agentTag, clientGone, deadlineHit, log } = deps;

    const { maxContinuation: MAX_CONTINUATION, continuationSizeThreshold: CONTINUATION_SIZE_THRESHOLD } = currentConfig();
    let continuationRounds = 0;
    
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
    runAutoContinuation,
};
