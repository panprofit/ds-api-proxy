'use strict';

const config = require('./config');

function retryBaseMs() { return config.get().accountMinCompletionIntervalMs; }

function exponentialBackoffMs(attempt, base = retryBaseMs()) {
    const n = Math.max(1, Math.floor(attempt) || 1);
    return base * (2 ** (n - 1));
}

function linearBackoffMs(streak, base = retryBaseMs()) {
    const n = Math.max(0, Math.floor(streak) || 0);
    return base * (n + 1);
}

module.exports = {
    retryBaseMs,
    exponentialBackoffMs,
    linearBackoffMs,
};
