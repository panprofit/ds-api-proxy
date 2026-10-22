'use strict';

const ENABLING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max']);
const ALL_EFFORTS = new Set(['none', ...ENABLING_EFFORTS]);
const THINKING_TYPES = new Set(['enabled', 'disabled', 'adaptive']);
const EFFORT_SCORES = Object.freeze({
    minimal: 50,
    low: 50,
    medium: 75,
    high: 75,
    xhigh: 75,
    ultra: 100,
    max: 100,
});

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidEffort(value) {
    return typeof value === 'string' && ALL_EFFORTS.has(value);
}

function effortEnablesThinking(value) {
    return typeof value === 'string' && ENABLING_EFFORTS.has(value);
}

function explicitThinking(value) {
    if (value === undefined || value === null) return null;
    return value.type !== 'disabled';
}

function resolveThinkingEnabled(params) {
    const explicit = explicitThinking(params?.thinking);
    if (explicit !== null) return explicit;
    return effortEnablesThinking(params?.reasoning_effort);
}

function resolveResponsesThinkingEnabled(params) {
    const explicit = explicitThinking(params?.thinking);
    if (explicit !== null) return explicit;
    const nested = params?.reasoning && typeof params.reasoning === 'object'
        ? params.reasoning.effort
        : undefined;
    const effort = nested !== undefined && nested !== null ? nested : params?.reasoning_effort;
    return effortEnablesThinking(effort);
}

function resolveReasoningEffortScore(params, { responses = false } = {}) {
    const enabled = responses
        ? resolveResponsesThinkingEnabled(params)
        : resolveThinkingEnabled(params);
    if (!enabled) return null;
    const effort = responses
        ? params?.reasoning?.effort ?? params?.reasoning_effort
        : params?.reasoning_effort;
    return EFFORT_SCORES[effort] ?? 75;
}

function validateThinkingParams(params, { responses = false } = {}) {
    if (params.thinking !== undefined && params.thinking !== null) {
        if (!isPlainObject(params.thinking) || !THINKING_TYPES.has(params.thinking.type)) {
            return 'Invalid thinking value: expected an object with type "enabled", "disabled" or "adaptive".';
        }
    }
    if (params.reasoning_effort !== undefined && params.reasoning_effort !== null
        && !isValidEffort(params.reasoning_effort)) {
        return `Invalid reasoning_effort value: expected one of "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max".`;
    }
    if (responses && params.reasoning !== undefined && params.reasoning !== null) {
        if (!isPlainObject(params.reasoning)) {
            return 'Invalid reasoning value: expected an object.';
        }
        const effort = params.reasoning.effort;
        if (effort !== undefined && effort !== null && !isValidEffort(effort)) {
            return `Invalid reasoning.effort value: expected one of "none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max".`;
        }
    }
    return null;
}

module.exports = {
    ENABLING_EFFORTS,
    ALL_EFFORTS,
    THINKING_TYPES,
    EFFORT_SCORES,
    resolveThinkingEnabled,
    resolveResponsesThinkingEnabled,
    resolveReasoningEffortScore,
    validateThinkingParams,
};
