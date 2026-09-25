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

function backoffDelay(attempt, base = RETRY_DELAY_MS, capFactor = 3) {
    return Math.min(base * attempt, base * capFactor);
}

module.exports = {
    currentConfig,
    retryDelayMs,
    sleep,
    backoffDelay,
    RETRY_DELAY_MS,
};
