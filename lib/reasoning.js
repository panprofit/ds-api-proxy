'use strict';
// Thinking-mode normalization shared by Chat Completions and Responses.
//
// The precedence mirrors DeepSeek's conversion rules: an explicit `thinking`
// setting wins over `reasoning_effort`, `none` disables thinking, and an
// absent setting keeps the proxy default (off, because DS reasoning is opt-in).
// Effort levels other than `none` only toggle thinking; the web API has no
// per-level control.

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

// Return the explicit `thinking` decision, or null when the setting is absent.
function explicitThinking(value) {
    if (value === undefined || value === null) return null;
    return value.type !== 'disabled';
}

// Resolve thinking for Chat Completions: `thinking` overrides
// `reasoning_effort`, which overrides the disabled default.
function resolveThinkingEnabled(params) {
    const explicit = explicitThinking(params?.thinking);
    if (explicit !== null) return explicit;
    return effortEnablesThinking(params?.reasoning_effort);
}

// Resolve thinking for Responses: an explicit `thinking` (a DeepSeek extension
// accepted for symmetry) overrides `reasoning.effort`, which overrides the
// top-level `reasoning_effort` accepted by older clients.
function resolveResponsesThinkingEnabled(params) {
    const explicit = explicitThinking(params?.thinking);
    if (explicit !== null) return explicit;
    const nested = params?.reasoning && typeof params.reasoning === 'object'
        ? params.reasoning.effort
        : undefined;
    const effort = nested !== undefined && nested !== null ? nested : params?.reasoning_effort;
    return effortEnablesThinking(effort);
}

// Resolve the numeric V4.1 effort score rendered into the system prompt, or
// null when thinking is disabled. Enabled thinking without an effort uses the
// high default (75), matching the reference template.
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

// Validate thinking-related request fields. Returns an error message or null.
// `responses` also accepts the Responses `reasoning` object.
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
