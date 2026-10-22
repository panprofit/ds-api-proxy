'use strict';

const configModule = require('./config');

function currentConfig() { return configModule.get(); }

function retryDelayMs() { return configModule.get().recoveryRetryDelayMs; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function memoizeParse(state, key, content, compute) {
    const memo = state.parseMemo || (state.parseMemo = {});
    const slot = memo[key];
    if (slot && slot.content === content) return slot.value;
    const value = compute(content);
    memo[key] = { content, value };
    return value;
}

function backoffDelay(attempt, base = retryDelayMs(), capFactor = 3) {
    return Math.min(base * attempt, base * capFactor);
}

module.exports = {
    currentConfig,
    retryDelayMs,
    sleep,
    backoffDelay,
    memoizeParse,
};
