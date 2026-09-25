'use strict';
// Central debug switch. `DS_DEBUG=1` (or `true`) enables verbose diagnostics,
// including messages emitted from catch blocks. Read lazily (per call) so
// tests can toggle it via an injected env object and `config.reload()` stays
// meaningful.

function isDebugEnabled(env = process.env) {
    const raw = String(env.DS_DEBUG || '').toLowerCase();
    return raw === '1' || raw === 'true';
}

// Call `log(...)` only when DS_DEBUG is enabled. `log` defaults to
// console.log so callers can pass an injected logger but must not care
// whether it is a no-op.
function debugLog(log, ...args) {
    if (!isDebugEnabled()) return;
    (typeof log === 'function' ? log : console.log)(...args);
}

module.exports = { isDebugEnabled, debugLog };
