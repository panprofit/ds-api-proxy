'use strict';

const configModule = require('./config');

function currentConfig() { return configModule.get(); }

function retryBaseMs() { return configModule.get().accountMinCompletionIntervalMs; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function memoizeParse(state, key, content, compute) {
    const memo = state.parseMemo || (state.parseMemo = {});
    const slot = memo[key];
    if (slot && slot.content === content) return slot.value;
    const value = compute(content);
    memo[key] = { content, value };
    return value;
}

function backoffDelay(attempt, base = retryBaseMs()) {
    const n = Math.max(1, Math.floor(attempt) || 1);
    return base * (2 ** (n - 1));
}

module.exports = {
    currentConfig,
    retryBaseMs,
    sleep,
    backoffDelay,
    memoizeParse,
};
