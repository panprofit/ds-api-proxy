'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');

function topLevelBindings(src) {
    const names = new Set();
    const beforeServer = src.split('const server = http.createServer')[0];

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

    const fre = /^function\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = fre.exec(beforeServer)) !== null) names.add(m[1]);
    return names;
}

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

test('lib/server.js: has a single top-level error handler that is fatal only before listen', () => {

    const handlerCount = (SERVER_SRC.match(/server\.on\('error'/g) || []).length;
    assert.equal(handlerCount, 1, 'expected exactly one server error handler');
    assert.match(SERVER_SRC, /if\s*\(!listening\)/);
    assert.match(SERVER_SRC, /let listening = false/);
});

test('lib/server.js: builds a shutdown controller without a TDZ trap', () => {

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

    assert.match(SERVER_SRC, /type: 'shutting_down'/);
    assert.match(SERVER_SRC, /if \(shuttingDown\(\)\)/);
});

test('index.js: does not import parser helpers it no longer uses', () => {
    for (const name of ['parseToolCall', 'looksLikeToolCallMarkup']) {
        assert.ok(
            !new RegExp(`\\b${name}\\b`).test(INDEX_SRC),
            `${name} is imported but never used in index.js`
        );
    }
});

test('lib/server.js: exposes socket timeouts and the GET /health endpoint', () => {
    assert.match(SERVER_SRC, /server\.headersTimeout\s*=/);
    assert.match(SERVER_SRC, /server\.requestTimeout\s*=/);

    assert.match(SERVER_SRC, /url\.pathname === '\/health'/);
    assert.doesNotMatch(SERVER_SRC, /url\.pathname === '\/status'/);
});
