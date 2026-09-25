'use strict';
// index.js fails fast when a required env var is missing. Run it in a child
// process so process.exit cannot take down the test runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const SERVER = path.join(__dirname, '..', 'index.js');

function runServer(env) {
    return spawnSync(process.execPath, [SERVER], {
        env: { ...process.env, DS_AUTH_DIR: '/nonexistent', ...env },
        encoding: 'utf8',
        timeout: 10000,
    });
}

// Pick a free TCP port by binding an ephemeral listener, then releasing it.
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

// Start the real server on `port` and wait until it logs that it is listening.
async function startServer(port, extraEnv = {}) {
    const child = spawn(process.execPath, [SERVER], {
        env: {
            ...process.env,
            DS_AUTH_DIR: '/nonexistent',
            DS_REMOTE_HOST: 'ds.test',
            HOST: '127.0.0.1',
            PORT: String(port),
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        if (out.includes('Server on')) return { child, log: () => out };
        if (child.exitCode !== null) throw new Error(`server exited early: ${out}`);
        await new Promise(r => setTimeout(r, 50));
    }
    child.kill('SIGKILL');
    throw new Error(`server did not start: ${out}`);
}

test('server: exits with a clear error when DS_REMOTE_HOST is missing', () => {
    const res = runServer({ DS_REMOTE_HOST: '' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DS_REMOTE_HOST/);
});

test('server: reports a bad DS_AUTH_DIR at startup but still listens', async () => {
    // /nonexistent is not a valid auth dir. The startup audit must call that
    // out (so a misconfiguration is obvious immediately), yet the server must
    // still start: requests are rejected later with a clear 503, not a crash.
    const port = await freePort();
    const { child, log } = await startServer(port);
    try {
        assert.match(log(), /DS_AUTH_DIR=\/nonexistent/);
        assert.match(log(), /Server on/);
    } finally {
        child.kill('SIGTERM');
    }
});

// --- Router smoke tests (live server) ---------------------------------------
//
// server.smoke.test.js asserts the router *source* has the right shape by
// grepping index.js. These tests instead boot the real server and exercise
// the routing table over HTTP, so a regression in the actual request handling
// (wrong status, missing CORS header, skipped body limit) is caught even when
// the source still looks right.
//
// No auth accounts exist (DS_AUTH_DIR=/nonexistent), but every case below is
// rejected *before* the code path that needs an account: routing, CORS
// preflight, body-size and JSON validation all run first.

async function withServer(fn, extraEnv = {}) {
    const port = await freePort();
    const { child } = await startServer(port, extraEnv);
    try {
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        child.kill('SIGTERM');
    }
}

test('router: GET /health is 200 with a JSON readiness report', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = await res.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.shutting_down, false);
        assert.ok(body.accounts && typeof body.accounts.total === 'number');
        assert.ok(body.concurrency, 'concurrency block present');
        assert.equal(typeof body.uptime_ms, 'number');
    });
});

test('router: POST /health is 405 (GET only)', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/health`, { method: 'POST', body: '{}' });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'GET');
    });
});

test('router: GET on an accepted path is 404 (only POST is served)', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/v1/chat/completions`);
        assert.equal(res.status, 404);
        assert.equal(await res.text(), 'Not found');
    });
});

test('router: POST to an unknown path is 404', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/v1/does-not-exist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.equal(res.status, 404);
    });
});

test('router: OPTIONS preflight returns 204 with CORS headers', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST' },
        });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
        assert.match(res.headers.get('access-control-allow-methods'), /POST/);
        assert.match(res.headers.get('access-control-allow-headers'), /Content-Type/);
    });
});

test('router: OPTIONS is answered even for an unknown path', async () => {
    // CORS is applied before routing, so a browser preflight never gets a bare
    // 404 without CORS headers (which the browser reports as a CORS error).
    await withServer(async (base) => {
        const res = await fetch(`${base}/nope`, { method: 'OPTIONS' });
        assert.equal(res.status, 204);
        assert.ok(res.headers.get('access-control-allow-methods'));
    });
});

test('router: invalid JSON on /v1/chat/completions is 400', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json',
        });
        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.error.type, 'invalid_request_error');
    });
});

test('router: invalid JSON on /v1/responses is 400', async () => {
    await withServer(async (base) => {
        const res = await fetch(`${base}/v1/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json',
        });
        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.error.type, 'invalid_request_error');
    });
});

test('router: a JSON array body is 400 on both endpoints', async () => {
    await withServer(async (base) => {
        for (const path of ['/v1/chat/completions', '/v1/responses']) {
            const res = await fetch(`${base}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '[]',
            });
            assert.equal(res.status, 400, `${path} should reject an array body`);
        }
    });
});

test('router: a body over DS_MAX_BODY_BYTES returns 413 payload_too_large', async () => {
    // readRequestBody() must drain-and-report rather than destroy the socket,
    // otherwise the router's 413 never reaches the client. The client should
    // read a real HTTP response with the payload_too_large error body.
    await withServer(async (base) => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
        });
        assert.equal(res.status, 413);
        const json = await res.json();
        assert.equal(json.error.type, 'payload_too_large');
    }, { DS_MAX_BODY_BYTES: '64' });
});
