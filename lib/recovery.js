'use strict';

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

const { currentConfig, backoffDelay, memoizeParse } = require('./recovery-util');
const { RETRY, ROTATE, SUCCESS, terminalError, rotateAccountAfterFailure, retrySameAccount } = require('./recovery-transitions');
const { runAutoContinuation } = require('./recovery-continuation');
const { handleAuthExpired, handleMutedAccount, terminalContextTooLong, handleTransientOutage, terminalOrRotateRecoverable } = require('./recovery-failures');
const metrics = require('./metrics');

async function beginAttempt(state, deps, ctl) {
    const {
        agentId, agentTag, session, messages, prompt, systemPrompt,
        askDSStream, readDSResponse, thinkingEnabled, searchEnabled,
        clientGone, deadlineHit, log,
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
    log(`${agentTag} Incremental prompt: ${state.pendingTurns.length} pending turn(s), ${incrementalPrompt.length} chars (full conversation would be ${prompt.length} chars)`);

    let initialCall;
    try {
        initialCall = await askDSStream({
            prompt: state.fullPrompt, agentId,
            freshSessionPrompt: state.freshPrompt,
            fileIds: state.fileIds,
            fileIdsAccountId: state.fileIdsAccountId,
            resolveFileIds: deps.resolveFileIds,
            thinkingEnabled: thinkingEnabled && !state.disableThinking,
            searchEnabled, deadlineHit, clientGone,
        });
    } catch (e) {
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

    const initialResult = await readDSResponse(dsResp.body, session, agentTag);
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

async function phaseActionPromise(state, deps, ctl) {
    const { agentId, agentTag, clientGone, rotationDeadlineHit, log } = deps;
    
    if (!(state.allowedToolNames.size > 0
        && !state.toolCall
        && !state.modelError
        && (state.finishReason === 'stop' || state.finishReason == null)
        && state.fullContent && state.fullContent.trim().length > 0
        && state.reasoningContent && state.reasoningContent.trim().length > 0)) {
        return null;
    }
    
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
    logGiveUp(log, agentTag, 'action-promise response', ctl.accountAttempt);
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
        clientGone, rotationDeadlineHit, log,
    } = deps;
    
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
    
    phaseThinkingToolFallback,
    phaseEmptyResponse,
    phaseAutoContinuation,
    phaseToolExtraction,
    phaseUnknownTool,
    
    phaseActionPromise,
    phaseBrokenMarkup,
    phaseRequiredToolCall,
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
        log = console.log,
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
        
        unknownToolName: null,
        retryAttempt: 0,
        
        muted: null,
        
        upstreamRetryAttempt: 0,
        upstreamRetryAccountId: null,
        
        upstreamFreshRetryDone: false,
        
        disableThinking: false,
        thinkingFallbackDone: false,
        
        sameAccountRetries: 0,
        
        fileIds,
        fileIdsAccountId,
    };
    
    const deps = {
        agentId, agentTag, session, messages, tools, prompt, systemPrompt, toolChoice,
        askDSStream, readDSResponse, thinkingEnabled, searchEnabled, stop,
        resolveFileIds,
        clientGone, deadlineHit, rotationDeadlineHit, log,
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
