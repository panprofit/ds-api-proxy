'use strict';
// Integration tests for lib/server.js. A real http.Server is built from
// injected fakes (semaphore, requestDeps, shutdown hooks) and driven through
// the private request listener, so the router, the fatal-before-listen error
// policy and the overload/drain/body-read branches are exercised without auth
// config or upstream calls. The listen test binds an ephemeral loopback port.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const config = require('../lib/config');
const { createServer } = require('../lib/server');

// A semaphore whose acquire() result the test controls.
function fakeSemaphore({ full = false } = {}) {
    return {
        inFlight: full ? 1 : 0,
        limit: 1,
        acquire() {
            if (full) return null;
            let released = false;
            return () => { if (released) return false; released = true; return true; };
        },
        waitForZero() { return Promise.resolve(true); },
    };
}

function fakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res.statusCode = null;
    res.headers = {};
    res.chunks = [];
    res.ended = false;
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.getHeader = (k) => res.headers[k];
    res.removeHeader = (k) => { delete res.headers[k]; };
    res.writeHead = (status, hdrs) => { res.statusCode = status; if (hdrs) Object.assign(res.headers, hdrs); res.headersSent = true; };
    res.write = (c) => { res.chunks.push(String(c)); return true; };
    res.end = (c) => { if (c !== undefined) res.chunks.push(String(c)); res.ended = true; };
    res.body = () => res.chunks.join('');
    return res;
}

// A fake request that emits its body chunks on the next tick.
function fakeReq({ method = 'POST', url = '/v1/chat/completions', host = 'localhost', chunks = ['{}'], fail = false } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host };
    req.socket = { remoteAddress: '127.0.0.1' };
    req.destroyed = false;
    req.resume = () => {};
    process.nextTick(() => {
        if (fail) { req.emit('error', new Error('socket')); return; }
        for (const c of chunks) req.emit('data', Buffer.from(c));
        req.emit('end');
    });
    return req;
}

function build(overrides = {}) {
    const logs = [];
    const errors = [];
    const exits = [];
    const srv = createServer({
        semaphore: fakeSemaphore(),
        requestDeps: {},
        port: 0,
        host: '127.0.0.1',
        log: (...a) => logs.push(a.join(' ')),
        error: (...a) => errors.push(a.join(' ')),
        exit: (code) => exits.push(code),
        ...overrides,
    });
    return { srv, logs, errors, exits };
}

// Invoke the private request listener directly.
async function dispatch(srv, req, res) {
    const listener = srv.server.listeners('request')[0];
    await listener(req, res);
}

test('createServer: exposes the shutdown controller and a shuttingDown helper', () => {
    const { srv } = build();
    assert.equal(typeof srv.shutdownCtl.shutdown, 'function');
    assert.equal(srv.shuttingDown(), false);
    assert.equal(srv.listening, false);
    srv.server.close();
});

test('createServer: a non-GET request to /health is 405', async () => {
    const { srv } = build();
    const res = fakeRes();
    await dispatch(srv, fakeReq({ method: 'POST', url: '/health' }), res);
    assert.equal(res.statusCode, 405);
    srv.server.close();
});

test('createServer: GET /v1/models lists the accepted model names', async () => {
    const { srv } = build();
    const res = fakeRes();
    await dispatch(srv, fakeReq({ method: 'GET', url: '/v1/models' }), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body());
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map(m => m.id), ['deepseek', 'deepseek-chat', 'deepseek-reasoner']);
    assert.ok(body.data.every(m => m.object === 'model'));
    srv.server.close();
});

test('createServer: POST /v1/models is 405', async () => {
    const { srv } = build();
    const res = fakeRes();
    await dispatch(srv, fakeReq({ method: 'POST', url: '/v1/models' }), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, 'GET');
    srv.server.close();
});

test('createServer: a malformed request URL is 400 instead of a hung socket', async () => {
    const { srv } = build();
    const res = fakeRes();
    // `//[` makes `new URL(req.url, base)` throw. The async request handler must
    // catch it and answer, not leak an unhandledRejection and stall the client.
    await dispatch(srv, fakeReq({ url: '//[' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body()).error.type, 'invalid_request_error');
    srv.server.close();
});

test('createServer: an unknown path is 404', async () => {
    const { srv } = build();
    const res = fakeRes();
    await dispatch(srv, fakeReq({ url: '/nope' }), res);
    assert.equal(res.statusCode, 404);
    srv.server.close();
});

test('createServer: a full semaphore answers 503 overloaded', async () => {
    const { srv } = build({ semaphore: fakeSemaphore({ full: true }) });
    const res = fakeRes();
    await dispatch(srv, fakeReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body()).error.type, 'overloaded');
    srv.server.close();
});

test('createServer: an oversized body is 413', async () => {
    config.reload({ DS_MAX_BODY_BYTES: '100' });
    try {
        const { srv } = build();
        const res = fakeRes();
        await dispatch(srv, fakeReq({ chunks: ['x'.repeat(80), 'x'.repeat(80)] }), res);
        assert.equal(res.statusCode, 413);
        assert.equal(res.headers.Connection, 'close');
        assert.equal(JSON.parse(res.body()).error.type, 'payload_too_large');
        srv.server.close();
    } finally {
        config.reload({});
    }
});

test('createServer: a stalled body read is 408', async () => {
    config.reload({ DS_BODY_READ_TIMEOUT_MS: '10' });
    try {
        const { srv } = build();
        const res = fakeRes();
        const req = new EventEmitter();
        req.method = 'POST';
        req.url = '/v1/chat/completions';
        req.headers = { host: 'localhost' };
        req.socket = { remoteAddress: '127.0.0.1' };
        req.resume = () => {};
        // Emit a chunk but never `end`, so the body-read timer fires.
        process.nextTick(() => req.emit('data', Buffer.from('{')));
        // Keep the event loop alive: readRequestBody unrefs its timeout, so
        // with nothing else pending the loop would exit before it fires.
        const keepAlive = setInterval(() => {}, 5);
        try {
            await dispatch(srv, req, res);
        } finally {
            clearInterval(keepAlive);
        }
        assert.equal(res.statusCode, 408);
        assert.equal(JSON.parse(res.body()).error.type, 'request_timeout');
        srv.server.close();
    } finally {
        config.reload({});
    }
});

test('createServer: a body-read socket error is 400', async () => {
    const { srv } = build();
    const res = fakeRes();
    await dispatch(srv, fakeReq({ fail: true }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body()).error.type, 'invalid_request_error');
    srv.server.close();
});

test('createServer: a fatal pre-listen error exits(1)', () => {
    const { srv, exits, errors } = build();
    const err = new Error('boom');
    err.code = 'EADDRINUSE';
    srv.server.emit('error', err);
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some(l => l.includes('already in use')));
    srv.server.close();
});

test('createServer: a generic pre-listen error exits(1)', () => {
    const { srv, exits, errors } = build();
    srv.server.emit('error', new Error('startup'));
    assert.deepEqual(exits, [1]);
    assert.ok(errors.some(l => l.includes('startup error')));
    srv.server.close();
});

test('createServer: listen works without a callback', async () => {
    const { srv } = build();
    await new Promise((resolve) => {
        srv.listen();
        // Poll `listening` until the bind callback flips it.
        const t = setInterval(() => { if (srv.listening) { clearInterval(t); resolve(); } }, 5);
    });
    assert.equal(srv.listening, true);
    await new Promise((resolve) => srv.server.close(resolve));
});

test('createServer: a runtime error after listen keeps the process alive', async () => {
    const { srv, exits, errors } = build();
    await new Promise((resolve) => srv.listen(resolve));
    assert.equal(srv.listening, true);
    srv.server.emit('error', new Error('EMFILE'));
    assert.deepEqual(exits, []);
    assert.ok(errors.some(l => l.includes('continuing')));
    await new Promise((resolve) => srv.server.close(resolve));
});

test('createServer: rejects new requests while draining', async () => {
    const { srv } = build();
    await srv.shutdownCtl.shutdown('SIGTERM');
    const res = fakeRes();
    await dispatch(srv, fakeReq(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body()).error.type, 'shutting_down');
    srv.server.close();
});
