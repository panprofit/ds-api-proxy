'use strict';

const { isRefusalContent, isToolResultEcho, stripToolResultEchoes, sanitizeContent } = require('./recovery-classify');
const { appendPromptInstruction } = require('./prompt');
const { currentConfig, retryBaseMs, sleep } = require('./recovery-util');

const VERDICT_INSTRUCTION = [
    'Before you answer, classify your own previous message.',
    'Reply with exactly one word and nothing else:',
    'DONE - the task is fully finished and that message is the final answer.',
    'CONTINUE - you meant to keep working (e.g. call a tool) but did not.',
].join('\n');

function parseVerdict(content) {
    const text = String(content || '').trim().toUpperCase();
    if (!text) return null;
    if (/^CONTINUE\b/.test(text)) return 'CONTINUE';
    if (/^DONE\b/.test(text)) return 'DONE';
    return null;
}

function shouldCheckCompletion(state) {
    if (!currentConfig().completionCheck) return false;
    if (state.completionChecked) return false;
    if (state.allowedToolNames.size === 0) return false;
    if (state.toolCall || state.modelError) return false;
    if (!(state.finishReason === 'stop' || state.finishReason == null)) return false;
    const text = String(state.fullContent || '').trim();
    if (!text) return false;
    if (text.length > currentConfig().completionCheckMaxChars) return false;
    if (isRefusalContent(text) || isToolResultEcho(text)) return false;
    return true;
}

async function askVerdict(state, deps) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, clientGone, log } = deps;
    const beforeId = session.accountId;
    const prompt = appendPromptInstruction(`${state.freshPrompt}\n\n[Your previous message]\n${state.fullContent}`, VERDICT_INSTRUCTION);
    const call = await askDSStream({
        prompt, agentId,
        freshSessionPrompt: prompt,
        fileIds: state.fileIds,
        fileIdsAccountId: state.fileIdsAccountId,
        resolveFileIds: deps.resolveFileIds,
        thinkingEnabled: false,
        searchEnabled: false,
        clientGone,
        abortSignal: deps.abortSignal,
    });
    if (call && call.fileIds) {
        state.fileIds = call.fileIds;
        state.fileIdsAccountId = call.fileIdsAccountId ?? state.fileIdsAccountId;
    }
    if (session.accountId && beforeId && session.accountId !== beforeId) {
        log(`${agentTag} completion check rotated account; skipping`);
        return null;
    }
    const raw = await readDSResponse(call.resp.body, session, agentTag);
    if (!raw) return null;
    return parseVerdict(stripToolResultEchoes(sanitizeContent(raw.content || '')));
}

async function runCompletionCheck(state, deps) {
    const { agentTag, clientGone, log, readDSResponse } = deps;
    if (!shouldCheckCompletion(state)) return null;

    state.completionChecked = true;
    if (clientGone()) return null;

    log(`${agentTag} short answer without a tool call; asking the model whether it is final`);
    await sleep(retryBaseMs());

    let verdict = null;
    try {
        verdict = await askVerdict(state, deps);
    } catch (e) {
        log(`${agentTag} completion check failed (${e && e.message ? e.message : e}); keeping the answer`);
        return null;
    }

    if (verdict !== 'CONTINUE') {
        log(`${agentTag} completion check verdict: ${verdict || 'unknown'}; keeping the answer`);
        return null;
    }

    log(`${agentTag} completion check verdict: CONTINUE; asking for the tool call`);
    const nudge = appendPromptInstruction(
        `${state.freshPrompt}\n\n[Assistant response so far]\n${state.fullContent}`,
        'You said you would act but did not call a tool. Do it now: call the appropriate tool instead of describing the next step.'
    );
    let raw;
    try {
        const call = await deps.askDSStream({
            prompt: nudge, agentId: deps.agentId,
            freshSessionPrompt: nudge,
            fileIds: state.fileIds,
            fileIdsAccountId: state.fileIdsAccountId,
            resolveFileIds: deps.resolveFileIds,
            thinkingEnabled: deps.thinkingEnabled,
            searchEnabled: deps.searchEnabled,
            clientGone,
            abortSignal: deps.abortSignal,
        });
        raw = await readDSResponse(call.resp.body, deps.session, agentTag);
    } catch (e) {
        log(`${agentTag} completion check follow-up failed (${e && e.message ? e.message : e}); keeping the answer`);
        return null;
    }
    if (!raw) return null;

    const content = raw.content ? stripToolResultEchoes(sanitizeContent(raw.content)) : '';
    const known = content
        ? require('./parser').parseToolCalls(content, () => {}).filter(call => state.allowedToolNames.has(call.name))
        : [];
    if (known.length === 0) {
        log(`${agentTag} follow-up produced no usable tool call; keeping the original answer`);
        return null;
    }

    state.toolCalls = known;
    state.toolCall = known[0];
    state.fullContent = `${state.fullContent}\n\n${content}`;
    if (raw.reasoningContent) state.reasoningContent = sanitizeContent(raw.reasoningContent);
    state.finishReason = raw.finishReason;
    state.modelError = raw.modelError || null;
    log(`${agentTag} completion check recovered tool call "${known[0].name}"`);
    return null;
}

module.exports = {
    runCompletionCheck,
    shouldCheckCompletion,
    parseVerdict,
};
