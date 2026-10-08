'use strict';
// Documentation parity between lib/config.js and .env.example.
//
// `lib/config.js` is the single source of truth for env parsing; `.env.example`
// is the operator-facing sample. Nothing keeps the two in sync today, so an
// env var added to one and forgotten in the other silently drifts (that is how
// DS_MAX_TOOL_RESULT_ECHO_RETRIES first shipped).
//
// The invariant enforced here:
//   1. every key in .env.example is actually read by lib/config.js (no dead
//      or misspelled sample keys), and
//   2. every key lib/config.js reads is either documented in .env.example or
//      explicitly listed below as intentionally undocumented.
//
// README.md is deliberately NOT parsed: its tables are hand-formatted and a
// few keys live in separate tables (auth helper, process management), so a
// regex would be brittle. This test covers the machine-checkable pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'config.js'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

// Keys `lib/config.js` reads that are intentionally absent from .env.example.
// Each is either "advanced" (kept out of the minimal sample) or belongs to the
// one-shot auth helper / process-management scripts and is documented in its
// own README table instead.
const UNDOCUMENTED_IN_EXAMPLE = new Set([
    // Advanced, documented in the README env table but not the sample.
    'DS_ALLOWED_ORIGINS',
    'DS_DEFAULT_SEARCH_ENABLED',
    'DS_REMOTE_HOST',
    'DS_SHUTDOWN_GRACE_MS',
    'DS_STREAM_KEEPALIVE_MS',
    // Auth helper (scripts/auth.js), documented in README's auth-helper table.
    'CHROME_PATH',
    'DS_AUTH_CDP_PORT',
    'DS_KEEP_PROFILE',
    'DS_LOGIN_FORM_TIMEOUT_MS',
    'DS_LOGIN_TIMEOUT_MS',
]);

function configKeys() {
    const keys = new Set();
    for (const m of CONFIG_SRC.matchAll(/env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
    return keys;
}

function exampleKeys() {
    const keys = new Set();
    for (const m of ENV_EXAMPLE.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)) keys.add(m[1]);
    return keys;
}

test('env docs: every .env.example key is read by lib/config.js', () => {
    const known = configKeys();
    const dead = [...exampleKeys()].filter((k) => !known.has(k)).sort();
    assert.deepEqual(dead, [], `.env.example keys not read by lib/config.js: ${dead.join(', ')}`);
});

test('env docs: every config.js key is either in .env.example or allowlisted', () => {
    const documented = exampleKeys();
    const missing = [...configKeys()]
        .filter((k) => !documented.has(k) && !UNDOCUMENTED_IN_EXAMPLE.has(k))
        .sort();
    assert.deepEqual(
        missing,
        [],
        `config.js keys missing from .env.example (add them there, or to UNDOCUMENTED_IN_EXAMPLE with a reason): ${missing.join(', ')}`
    );
});

test('env docs: UNDOCUMENTED_IN_EXAMPLE has no stale entries', () => {
    const known = configKeys();
    const documented = exampleKeys();
    const stale = [...UNDOCUMENTED_IN_EXAMPLE]
        .filter((k) => !known.has(k) || documented.has(k))
        .sort();
    assert.deepEqual(
        stale,
        [],
        `allowlist entries that are no longer undocumented (key removed from config.js or added to .env.example): ${stale.join(', ')}`
    );
});
