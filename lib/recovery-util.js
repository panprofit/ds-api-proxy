'use strict';

const configModule = require('./config');
const { retryBaseMs, exponentialBackoffMs } = require('./backoff');

function currentConfig() { return configModule.get(); }

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
    return exponentialBackoffMs(attempt, base);
}

module.exports = {
    currentConfig,
    retryBaseMs,
    sleep,
    backoffDelay,
    memoizeParse,
};
