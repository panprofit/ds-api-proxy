'use strict';
// Regression smoke tests for the process/server wiring.
//
// The HTTP router and lifecycle live in lib/server.js (buildable from injected
// deps), while index.js is a thin process launcher (env guard, signal handlers,
// idle sweep). These tests read both sources and assert the wiring is actually
// reachable, guarding against the class of bug where a file *calls* a helper it
// never imported: the file loads fine and all lib unit tests pass, but the
// first error throws `ReferenceError: x is not defined`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');

// Identifiers that are declared/imported somewhere in a file's top-level
// bindings. Used to catch free variables in the error paths.
function topLevelBindings(src) {
    const names = new Set();
    const beforeServer = src.split('const server = http.createServer')[0];
    // const/let/var destructuring and plain declarations at column 0.
    const re = /^(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/gm;
    let m;
    while ((m = re.exec(beforeServer)) !== null) {
        if (m[1]) {
            for (const part of m[1].split(',')) {
                const key = part.split(':').pop().trim().replace(/[\s\S]*?([A-Za-z_$][\w$]*)\s*$/, '$1');
                if (key) names.add(key);
            }
        }
        if (m[2]) names.add(m[2]);
    }
    // Function declarations.
    const fre = /^function\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = fre.exec(beforeServer)) !== null) names.add(m[1]);
    return names;
}

// Free identifiers referenced in a source file that are not JS globals and not
// declared locally. Deliberately small list of names that have historically
// gone missing from imports.
const KNOWN_HELPERS = [
    'markAccountFailure',
    'markAccountBroken',
    'createUpstreamHttpError',
    'selectAccountForSession',
    'resetRemoteSession',
    'getOrCreateAgentSession',
];

test('index.js: every helper it calls is imported/declared', () => {
    const bindings = topLevelBindings(INDEX_SRC);
    for (const name of KNOWN_HELPERS) {
        const called = new RegExp(`(?:^|[^\\w.])${name}\\s*\\(`, 'm').test(INDEX_SRC);
        if (!called) continue;
        assert.ok(
            bindings.has(name),
            `${name}() is called in index.js but is not imported/declared`
        );
    }
});

test('index.js: module loads without DS_REMOTE_HOST? it exits by design', () => {
    // index.js intentionally process.exit(1)s when DS_REMOTE_HOST is missing.
    assert.match(INDEX_SRC, /DS_REMOTE_HOST/);
    assert.match(INDEX_SRC, /process\.exit\(1\)/);
});

test('lib/server.js: has a single top-level error handler that is fatal only before listen', () => {
    // #14: runtime server errors must not kill the process. The handler must be
    // attached once, and must gate process.exit on the `listening` flag.
    const handlerCount = (SERVER_SRC.match(/server\.on\('error'/g) || []).length;
    assert.equal(handlerCount, 1, 'expected exactly one server error handler');
    assert.match(SERVER_SRC, /if\s*\(!listening\)/);
    assert.match(SERVER_SRC, /let listening = false/);
});

test('lib/server.js: builds a shutdown controller without a TDZ trap', () => {
    // The router reads `shutdownCtl` through the shuttingDown() helper, which
    // tolerates the null window, so there is no reliance on a later `const`.
    assert.match(SERVER_SRC, /let shutdownCtl = null/);
    assert.match(SERVER_SRC, /shutdownCtl = createShutdown\(/);
    assert.match(SERVER_SRC, /function shuttingDown\(\) \{/);
    assert.match(SERVER_SRC, /shutdownCtl && shutdownCtl\.shuttingDown/);
    assert.ok(!/const shutdownCtl = createShutdown/.test(SERVER_SRC), 'must not be a later const');
});

test('index.js: wires SIGTERM/SIGINT to the graceful-shutdown controller', () => {
    assert.match(INDEX_SRC, /createServer/);
    assert.match(INDEX_SRC, /pendingDeletesSize: \(\) => pendingDeletes\.size/);
    assert.match(INDEX_SRC, /resetAllRemoteSessions/);
    assert.match(INDEX_SRC, /process\.on\('SIGTERM', \(\) => runtime\.shutdownCtl\.shutdown\('SIGTERM'\)\)/);
    assert.match(INDEX_SRC, /process\.on\('SIGINT', \(\) => runtime\.shutdownCtl\.shutdown\('SIGINT'\)\)/);
});

test('lib/server.js: rejects new requests while draining', () => {
    // The router must return 503 + shutting_down before acquiring a slot.
    assert.match(SERVER_SRC, /type: 'shutting_down'/);
    assert.match(SERVER_SRC, /if \(shuttingDown\(\)\)/);
});

test('index.js: does not import parser helpers it no longer uses', () => {
    for (const name of ['parseToolCall', 'looksLikeToolCallMarkup', 'hasUnclosedToolMarkup']) {
        assert.ok(
            !new RegExp(`\\b${name}\\b`).test(INDEX_SRC),
            `${name} is imported but never used in index.js`
        );
    }
});

test('lib/server.js: exposes socket timeouts and the GET /health endpoint', () => {
    assert.match(SERVER_SRC, /server\.headersTimeout\s*=/);
    assert.match(SERVER_SRC, /server\.requestTimeout\s*=/);
    // The only GET endpoint is /health; there is no /status.
    assert.match(SERVER_SRC, /url\.pathname === '\/health'/);
    assert.doesNotMatch(SERVER_SRC, /url\.pathname === '\/status'/);
});
