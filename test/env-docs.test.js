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
// .env.example comments every key out (`# KEY=value`) so that copying it does
// not silently freeze today's defaults; exampleKeys() therefore accepts an
// optional `#` before the name.
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
// Empty today: .env.example lists every key, commented out, including the
// auth-helper ones; a new exception must carry its reason here.
const UNDOCUMENTED_IN_EXAMPLE = new Set([]);

// Read lazily by lib/debug.js and lib/sse.js instead of lib/config.js (see
// AGENTS.md -> Architecture), so they are invisible to configKeys() but still
// documented in .env.example and must not be flagged as dead.
const LAZY_ENV_KEYS = new Set(['DS_DEBUG', 'DS_DUMP_SSE']);

function configKeys() {
    const keys = new Set(LAZY_ENV_KEYS);
    for (const m of CONFIG_SRC.matchAll(/env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
    return keys;
}

function exampleKeys() {
    const keys = new Set();
    for (const m of ENV_EXAMPLE.matchAll(/^\s*#?\s*([A-Z0-9_]+)\s*=/gm)) keys.add(m[1]);
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
