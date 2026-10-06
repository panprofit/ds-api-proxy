'use strict';
// Shared retry/config helpers for the recovery passes. The retry-delay math
// and the config accessor are one small, separately reviewable unit used by
// both ./recovery and ./recovery-markup.

const configModule = require('./config');

// Read recovery knobs at call time (not a load-time snapshot), matching the
// request path in handlers.js. RETRY_DELAY_MS is the load-time default kept
// for callers/tests that do not pass a base to backoffDelay().
function currentConfig() { return configModule.get(); }

const RETRY_DELAY_MS = configModule.get().recoveryRetryDelayMs;

function retryDelayMs() { return configModule.get().recoveryRetryDelayMs; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Memoize a per-content parse result on the shared recovery `state` object.
// The recovery phases run parseToolCall()/hasUnclosedToolMarkup() on the same
// fullContent several times per attempt; for large DSML/JSON bodies that is a
// repeated full parse. `key` keeps the two computations from colliding (same
// content, different result shape). The cache invalidates itself whenever
// `content` changes (a completion round appends), so no explicit reset is
// needed.
function memoizeParse(state, key, content, compute) {
    const memo = state.parseMemo || (state.parseMemo = {});
    const slot = memo[key];
    if (slot && slot.content === content) return slot.value;
    const value = compute(content);
    memo[key] = { content, value };
    return value;
}

function backoffDelay(attempt, base = RETRY_DELAY_MS, capFactor = 3) {
    return Math.min(base * attempt, base * capFactor);
}

module.exports = {
    currentConfig,
    retryDelayMs,
    sleep,
    backoffDelay,
    memoizeParse,
    RETRY_DELAY_MS,
};
