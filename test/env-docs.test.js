'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'config.js'), 'utf8');
const ENV_EXAMPLE = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const UNDOCUMENTED_IN_EXAMPLE = new Set([]);

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
