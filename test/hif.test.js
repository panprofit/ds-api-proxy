'use strict';
// Unit tests for lib/hif.js. The network is injected; the module's cache is
// reset per test so the cases stay independent.

const test = require('node:test');
const assert = require('node:assert/strict');

const hif = require('../lib/hif');

function response(value, ttl = '600') {
    return {
        ok: true,
        headers: { get: (k) => (k.toLowerCase() === 'x-hif-ttl' ? ttl : null) },
        json: async () => ({ data: { biz_data: { value } } }),
    };
}

test('getHifValue: fetches once and serves the cached value', async () => {
    hif.resetCache();
    let calls = 0;
    const fetchImpl = async () => { calls++; return response('V1'); };
    assert.equal(await hif.getHifValue({ fetchImpl, now: () => 1000 }), 'V1');
    assert.equal(await hif.getHifValue({ fetchImpl, now: () => 1000 + 500000 }), 'V1');
    assert.equal(calls, 1);
});

test('getHifValue: refetches after the advertised TTL', async () => {
    hif.resetCache();
    let value = 'V1';
    let calls = 0;
    const fetchImpl = async () => { calls++; return response(value); };
    assert.equal(await hif.getHifValue({ fetchImpl, now: () => 0 }), 'V1');
    value = 'V2';
    assert.equal(await hif.getHifValue({ fetchImpl, now: () => 600000 }), 'V2');
    assert.equal(calls, 2);
});

test('getHifValue: failures are not cached and never throw', async () => {
    hif.resetCache();
    let calls = 0;
    const failing = async () => { calls++; throw new Error('offline'); };
    assert.equal(await hif.getHifValue({ fetchImpl: failing, now: () => 0 }), '');
    assert.equal(await hif.getHifValue({ fetchImpl: failing, now: () => 1 }), '');
    assert.equal(calls, 2);

    const malformed = async () => response('');
    assert.equal(await hif.getHifValue({ fetchImpl: malformed, now: () => 2 }), '');
});

test('getHifValue: concurrent callers share one in-flight fetch', async () => {
    hif.resetCache();
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchImpl = async () => { calls++; await gate; return response('V1'); };
    const first = hif.getHifValue({ fetchImpl, now: () => 0 });
    const second = hif.getHifValue({ fetchImpl, now: () => 0 });
    release();
    assert.deepEqual(await Promise.all([first, second]), ['V1', 'V1']);
    assert.equal(calls, 1);
});

test('refreshHifHeaders: overrides the captured header only on success', async () => {
    hif.resetCache();
    const headers = { 'x-hif-leim': 'CAPTURED' };
    await hif.refreshHifHeaders(headers, { fetchImpl: async () => response('FRESH'), now: () => 0 });
    assert.equal(headers['x-hif-leim'], 'FRESH');

    const failing = { 'x-hif-leim': 'CAPTURED' };
    await hif.refreshHifHeaders(failing, {
        fetchImpl: async () => { throw new Error('offline'); },
        now: () => 700000,
    });
    assert.equal(failing['x-hif-leim'], 'CAPTURED');
});
