'use strict';

function isDebugEnabled(env = process.env) {
    const raw = String(env.DS_DEBUG || '').toLowerCase();
    return raw === '1' || raw === 'true';
}

function debugLog(log, ...args) {
    if (!isDebugEnabled()) return;
    (typeof log === 'function' ? log : console.log)(...args);
}

function debugLogEnv(log, env, ...args) {
    if (!isDebugEnabled(env)) return;
    (typeof log === 'function' ? log : console.log)(...args);
}

module.exports = { isDebugEnabled, debugLog, debugLogEnv };
