'use strict';

const {
    sanitizeContent,
    isToolResultEcho,
    stripToolResultEchoes,
    classifyRecoveryFailure,
    isUpstreamTransientError,
} = require('./recovery-classify');
const {
    composePrompt,
    collectPendingTurns,
    markTurnsSent,
    formatPendingTurns,
    extractScreenshotPaths,
    appendPromptInstruction,
    toolQualifiedName,
} = require('./prompt');

const { parseToolCall, looksLikeToolCallMarkup } = require('./parser');
const accounts = require('./accounts');
const { isTimeoutError } = require('./http');

const { currentConfig, backoffDelay, memoizeParse } = require('./recovery-util');
const { RETRY, ROTATE, SUCCESS, terminalError, rotateAccountAfterFailure, retrySameAccount } = require('./recovery-transitions');
const { continueReasoningOnly, runAutoContinuation } = require('./recovery-continuation');
const { runCompletionCheck } = require('./recovery-completion-check');
const { handleAuthExpired, handleMutedAccount, terminalContextTooLong, handleTransientOutage, terminalOrRotateRecoverable } = require('./recovery-failures');
const metrics = require('./metrics');

function carryReasoning(previous, next) {
    const prev = String(previous || '').trim();
    const nxt = String(next || '').trim();
    if (!nxt) return prev;
    if (!prev) return nxt;
    if (prev === nxt || prev.includes(nxt)) return prev;
    if (nxt.includes(prev)) return nxt;
    return `${prev}\n\n${nxt}`;
}

function previousReasoningInstruction(reasoning) {
    return 'The previous attempt ended with malformed tool-call markup. '
        + 'Use the previous reasoning below and emit the tool call immediately using valid markup. '
        + 'Do not repeat the reasoning.\n\n'
        + `[Previous reasoning]\n${reasoning}`;
}

async function beginAttempt(state, deps, ctl) {
    const {
        agentId, agentTag, session, messages, prompt, systemPrompt,
        askDSStream, readDSResponse, thinkingEnabled, searchEnabled,
        clientGone, deadlineHit, abortSignal, log,
    } = deps;

    state.reusingRemoteSession = Boolean(session.id) && session.messageCount > 0;

    state.pendingTurns = collectPendingTurns(messages, session);
    const incrementalPrompt = state.pendingTurns.length > 0 ? formatPendingTurns(state.pendingTurns) : '';

    const conversationPrompt = state.reusingRemoteSession
        ? (incrementalPrompt || prompt)
        : prompt;

    state.fullPrompt = state.reusingRemoteSession
        ? composePrompt('', conversationPrompt)
        : composePrompt(systemPrompt, conversationPrompt);
    state.freshPrompt = composePrompt(systemPrompt, prompt);
    let freshSessionPrompt = state.freshPrompt;
    if (state.brokenMarkupReasoning) {
        freshSessionPrompt = appendPromptInstruction(
            state.freshPrompt,
            previousReasoningInstruction(state.brokenMarkupReasoning)
        );
        if (!state.reusingRemoteSession) state.fullPrompt = freshSessionPrompt;
        log(`${agentTag} Injecting ${state.brokenMarkupReasoning.length} chars of previous reasoning into the fresh session prompt`);
    }
    log(`${agentTag} Incremental prompt: ${state.pendingTurns.length} pending turn(s), ${incrementalPrompt.length} chars (full conversation would be ${prompt.length} chars)`);

    let initialCall;
    try {
        initialCall = await askDSStream({
            prompt: state.fullPrompt, agentId,
            freshSessionPrompt,
            fileIds: state.fileIds,
            fileIdsAccountId: state.fileIdsAccountId,
            resolveFileIds: deps.resolveFileIds,
            thinkingEnabled,
            searchEnabled, deadlineHit, clientGone,
            abortSignal,
        });
    } catch (e) {
        if (isTimeoutError(e) && !clientGone()) {
            state.fullContent = '';
            state.reasoningContent = '';
            state.finishReason = null;
            state.modelError = { type: 'request_timeout', content: e.message || 'request timed out', finish_reason: null };
            return null;
        }
        return handleAuthExpired(e, deps, ctl);
    }
    if (initialCall.fileIds) {
        state.fileIds = initialCall.fileIds;
        state.fileIdsAccountId = initialCall.fileIdsAccountId ?? state.fileIdsAccountId;
    }
    const dsResp = initialCall.resp;
    if (initialCall.promptUsed !== state.fullPrompt) {
        state.fullPrompt = initialCall.promptUsed;
    }

    const initialResult = await readDSResponse(dsResp.body, session, agentTag, { onReasoningDelta: deps.onReasoningDelta });
    ({ content: state.fullContent, reasoningContent: state.reasoningContent, finishReason: state.finishReason, modelError: state.modelError } = initialResult);

    state.muted = initialResult.muted || null;
    state.fullContent = sanitizeContent(state.fullContent);
    state.reasoningContent = sanitizeContent(state.reasoningContent || '');
    log(`${agentTag} Got ${state.fullContent.length} chars (+${state.reasoningContent.length} reasoning chars) (msg#${session.messageCount})`);
    return null;
}

function logGiveUp(log, agentTag, label, accountAttempt) {
    log(`${agentTag} ${label} on all ${accountAttempt + 1} account attempt(s). Giving up.`);
}

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
    logGiveUp(log, agentTag, 'fabricated tool-result envelope', ctl.accountAttempt);
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

async function phaseReasoningOnly(state, deps, ctl) {
    const { agentId, agentTag, clientGone, deadlineHit, rotationDeadlineHit, log } = deps;
    const reasoningOnly = (!state.fullContent || state.fullContent.trim().length === 0)
        && state.reasoningContent && state.reasoningContent.trim().length > 0
        && !state.modelError;
    if (!reasoningOnly) return null;

    if (await continueReasoningOnly(state, deps)) return null;

    const reason = 'reasoning-only response (no visible answer)';
    if (await retrySameAccount({
        state, session: deps.session, agentTag,
        reason,
        log, clientGone, deadlineHit,
    })) {
        return RETRY;
    }

    const { failure, rotated } = await rotateAccountAfterFailure({
        session: deps.session, accountAttempt: ctl.accountAttempt, agentTag,
        reason,
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    logGiveUp(log, agentTag, 'reasoning-only response', ctl.accountAttempt);
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

async function requestToolCallReprompt(state, deps, instruction, label, sameSessionPrompt = null, freshSessionReasoning = '') {
    const { agentTag, session, askDSStream, readDSResponse, clientGone, deadlineHit, log } = deps;
    const beforeAccountId = session.accountId;
    const beforeParentId = session.parentMessageId;
    const freshInstruction = freshSessionReasoning
        ? previousReasoningInstruction(freshSessionReasoning)
        : instruction;
    const nudge = appendPromptInstruction(state.freshPrompt, freshInstruction);
    const prompt = sameSessionPrompt !== null
        ? appendPromptInstruction(sameSessionPrompt, instruction)
        : nudge;
    let call;
    try {
        call = await askDSStream({
            prompt, agentId: deps.agentId,
            freshSessionPrompt: nudge,
            fileIds: state.fileIds,
            fileIdsAccountId: state.fileIdsAccountId,
            resolveFileIds: deps.resolveFileIds,
            thinkingEnabled: deps.thinkingEnabled,
            searchEnabled: deps.searchEnabled,
            deadlineHit, clientGone,
        });
    } catch (e) {
        log(`${agentTag} ${label} failed (${e && e.message ? e.message : e}); falling through`);
        return null;
    }
    if (call.fileIds) {
        state.fileIds = call.fileIds;
        state.fileIdsAccountId = call.fileIdsAccountId ?? state.fileIdsAccountId;
    }
    if ((session.accountId && beforeAccountId && session.accountId !== beforeAccountId)
        || (session.parentMessageId && beforeParentId && session.parentMessageId !== beforeParentId)) {
        log(`${agentTag} ${label} changed the remote session; skipping`);
        return null;
    }

    const raw = await readDSResponse(call.resp.body, session, agentTag, { onReasoningDelta: deps.onReasoningDelta });
    if (!raw) return null;
    return {
        content: raw.content ? stripToolResultEchoes(sanitizeContent(raw.content)) : '',
        raw,
    };
}

async function phaseToolCallReprompt(state, deps) {
    const { agentTag, tools, thinkingEnabled, clientGone, deadlineHit, log } = deps;
    if (state.toolCallRepromptDone) return null;
    if (!thinkingEnabled) return null;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    if (!isUpstreamTransientError(state.modelError)) return null;
    if (!state.reasoningContent || !state.reasoningContent.trim()) return null;
    if (state.fullContent && state.fullContent.trim()) return null;
    if (clientGone()) return null;

    state.toolCallRepromptDone = true;
    metrics.inc('toolCallReprompts');
    log(`${agentTag} DS aborted a tool-call turn after reasoning (${state.modelError?.finish_reason || 'generation_err'}); re-prompting the same session for the tool call.`);

    const repromptDeps = deadlineHit() ? { ...deps, deadlineHit: () => false } : deps;
    const reprompt = await requestToolCallReprompt(
        state, repromptDeps,
        'Your previous turn was interrupted after the reasoning step and no tool call was emitted. '
        + 'Emit the tool call now. Do not repeat the reasoning.',
        'tool-call re-prompt'
    );
    if (!reprompt) return null;

    const { content, raw } = reprompt;
    state.modelError = raw.modelError || null;
    if (!content || (state.modelError && !raw.finishReason)) {
        log(`${agentTag} tool-call re-prompt produced nothing usable; falling through to the normal recovery`);
        state.fullContent = '';
        state.reasoningContent = raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : state.reasoningContent;
        state.finishReason = raw.finishReason ?? null;
        return null;
    }

    state.fullContent = content;
    state.reasoningContent = raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : state.reasoningContent;
    state.finishReason = raw.finishReason;
    const parsed = parseToolCall(content, () => {});
    if (parsed && parsed.name) {
        state.toolCall = parsed;
        log(`${agentTag} tool-call re-prompt recovered tool call "${parsed.name}"`);
    }
    return null;
}

async function phaseEmptyResponse(state, deps, ctl) {
    const { deadlineHit } = deps;

    if (!(!state.fullContent || state.fullContent.trim().length === 0)) return null;

    metrics.inc('emptyResponses');
    const timedOut = deadlineHit();
    const failureClass = classifyRecoveryFailure(state.modelError, timedOut);

    if (state.muted) return handleMutedAccount(state, deps, ctl);

    if (failureClass.type === 'context_length_exceeded') {
        return terminalContextTooLong(state, deps, ctl, failureClass);
    }
    if (isUpstreamTransientError(state.modelError)) {
        return handleTransientOutage(state, deps, ctl, failureClass);
    }
    return terminalOrRotateRecoverable(state, deps, ctl, failureClass, timedOut);
}

async function phaseAutoContinuation(state, deps) {
    await runAutoContinuation(state, deps);
    return null;
}

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
    logGiveUp(log, agentTag, `unavailable tool "${state.unknownToolName}"`, ctl.accountAttempt);
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

async function phaseBrokenMarkup(state, deps, ctl) {
    const {
        agentId, agentTag, session,
        clientGone, deadlineHit, rotationDeadlineHit, log,
    } = deps;

    const hasBrokenToolMarkup = state.allowedToolNames.size > 0
        && !state.toolCall
        && looksLikeToolCallMarkup(state.fullContent)
        && memoizeParse(state, 'call', state.fullContent, parseToolCall) === null;
    if (!hasBrokenToolMarkup) return null;

    state.brokenMarkupReasoning = carryReasoning(state.brokenMarkupReasoning, state.reasoningContent);

    if (!clientGone()) {
        log(`${agentTag} Broken tool markup; re-prompting the same session for the tool call.`);
        metrics.inc('toolCallReprompts');
        const repromptDeps = deadlineHit() ? { ...deps, deadlineHit: () => false } : deps;
        const reprompt = await requestToolCallReprompt(
            state, repromptDeps,
            'Your previous response contained malformed tool-call markup. '
            + 'Emit the tool call again using valid markup. Do not repeat the reasoning.',
            'broken tool-call re-prompt',
            state.fullPrompt,
            state.brokenMarkupReasoning
        );
        if (reprompt) {
            const { content, raw } = reprompt;
            state.modelError = raw.modelError || null;
            state.reasoningContent = raw.reasoningContent ? sanitizeContent(raw.reasoningContent) : state.reasoningContent;
            state.finishReason = raw.finishReason ?? state.finishReason;
            if (content && !(state.modelError && !raw.finishReason)) {
                state.fullContent = content;
                const parsed = memoizeParse(state, 'call', content, parseToolCall);
                if (parsed && parsed.name) {
                    if (state.allowedToolNames.has(parsed.name)) {
                        state.toolCall = parsed;
                        log(`${agentTag} broken tool-call re-prompt recovered tool call "${parsed.name}"`);
                    } else {
                        state.unknownToolName = parsed.name;
                        state.toolCall = null;
                    }
                    return null;
                }
            }
            log(`${agentTag} broken tool-call re-prompt produced nothing usable; falling through`);
        }
    }

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

function toolCallMatches(state, requested) {
    if (!state.toolCall) return false;
    const actual = state.toolCall.name;
    return actual === requested || actual.endsWith(`::${requested}`);
}

async function phaseRequiredToolCall(state, deps, ctl) {
    const { agentId, agentTag, toolChoice, clientGone, rotationDeadlineHit, log } = deps;
    if (state.allowedToolNames.size === 0) return null;
    if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none') return null;

    const requested = toolChoice === 'required' ? null : String(toolChoice.name || '');
    if (requested === null ? Boolean(state.toolCall) : toolCallMatches(state, requested)) return null;

    const expected = requested === null ? 'a tool call' : `the tool "${requested}"`;
    log(`${agentTag} tool_choice ${JSON.stringify(toolChoice)} was not satisfied by the response.`);
    const { failure, rotated } = await rotateAccountAfterFailure({
        session: deps.session, accountAttempt: ctl.accountAttempt, agentTag,
        reason: `tool_choice unmet (${expected})`,
        log, clientGone, rotationDeadlineHit,
    });
    if (rotated) return ROTATE;
    const allCooling = !accounts.hasAvailableAccount();
    metrics.inc('toolChoiceUnmet');
    return terminalError({
        status: 502,
        type: 'tool_choice_unmet',
        message: `Model did not return ${expected} required by tool_choice; no other account available.`,
        allCooling,
        agentId,
        failure,
        extra: {
            tool_choice: toolChoice,
            actual_tool: state.toolCall?.name || null,
            account_attempts: ctl.accountAttempt + 1,
        },
    });
}

const RECOVERY_PHASES = [
    beginAttempt,

    phaseToolResultEcho,
    phaseReasoningOnly,

    phaseToolCallReprompt,
    phaseEmptyResponse,
    phaseAutoContinuation,
    phaseToolExtraction,

    phaseBrokenMarkup,
    phaseUnknownTool,
    phaseRequiredToolCall,

    runCompletionCheck,
];

async function runRecoveryAttempt(state, deps, ctl) {
    for (const phase of RECOVERY_PHASES) {
        const transition = await phase(state, deps, ctl);
        if (transition) return transition;
    }
    return SUCCESS;
}

function finalizeSuccess(state, deps) {
    const { agentTag, session, messages, stop, log } = deps;

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

    if (!state.fullContent.includes('MEDIA:')) {
        const screenshotPaths = extractScreenshotPaths(messages);
        if (screenshotPaths.length > 0) {
            state.fullContent += '\n\n' + screenshotPaths.join('\n');
            log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
        }
    }

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

        contextTokens: session.contextTokens || 0,
        pendingTurns: state.pendingTurns,
        reusingRemoteSession: state.reusingRemoteSession,
        retryAttempt: state.retryAttempt,
    };
}

async function runWithRecovery(ctx) {
    const {

        agentId, agentTag, session, messages, tools, prompt, systemPrompt,
        toolChoice = 'auto',

        askDSStream, readDSResponse,

        fileIds = [],
        fileIdsAccountId = null,
        resolveFileIds = null,
        thinkingEnabled = undefined,
        searchEnabled = undefined,
        stop = [],

        clientGone = () => false,
        deadlineHit = () => false,
        abortSignal = null,
        log = console.log,
        onReasoningDelta = null,
    } = ctx;

    const maxAccountAttempts = Math.max(1, accounts.getAccounts().length);

    const rotationStartedAt = Date.now();
    const rotationBudgetMs = currentConfig().rotationBudgetMs;

    const rotationDeadlineHit = () => deadlineHit() || Date.now() - rotationStartedAt > rotationBudgetMs;

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
        completionChecked: false,

        unknownToolName: null,
        retryAttempt: 0,

        muted: null,

        upstreamRetryAttempt: 0,
        upstreamRetryAccountId: null,

        upstreamFreshRetryDone: false,

        toolCallRepromptDone: false,

        brokenMarkupReasoning: '',

        sameAccountRetries: 0,

        fileIds,
        fileIdsAccountId,
    };

    const deps = {
        agentId, agentTag, session, messages, tools, prompt, systemPrompt, toolChoice,
        askDSStream, readDSResponse, thinkingEnabled, searchEnabled, stop,
        resolveFileIds,
        clientGone, deadlineHit, rotationDeadlineHit, log,
        abortSignal,
        onReasoningDelta,
    };

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
