'use strict';
// Unit tests for lib/upload-cache.js. The module owns a singleton Map, so
// each test clears it first.

const test = require('node:test');
const assert = require('node:assert/strict');

const uploadCache = require('../lib/upload-cache');
const config = require('../lib/config');

function reset() {
    uploadCache.getCache().clear();
}

test('upload-cache: set/get/has round-trip', () => {
    reset();
    uploadCache.set('k', { id: 'f1', filename: 'a.png', cachedAt: Date.now() });
    assert.equal(uploadCache.has('k'), true);
    assert.equal(uploadCache.get('k').id, 'f1');
    assert.equal(uploadCache.size(), 1);
});

test('upload-cache: missing key returns undefined and has=false', () => {
    reset();
    assert.equal(uploadCache.get('nope'), undefined);
    assert.equal(uploadCache.has('nope'), false);
});

test('upload-cache: sweep removes entries older than the TTL', () => {
    reset();
    const now = Date.now();
    uploadCache.set('stale', { id: 'f1', cachedAt: now - 10_000 });
    uploadCache.set('fresh', { id: 'f2', cachedAt: now });
    const removed = uploadCache.sweep(now, 5000);
    assert.equal(removed, 1);
    assert.equal(uploadCache.has('stale'), false);
    assert.equal(uploadCache.has('fresh'), true);
});

test('upload-cache: sweep drops malformed (null) entries', () => {
    reset();
    uploadCache.set('nil', null);
    assert.equal(uploadCache.sweep(Date.now(), 5000), 1);
    assert.equal(uploadCache.has('nil'), false);
});

test('upload-cache: sweep keeps entries exactly at the TTL boundary', () => {
    reset();
    const now = Date.now();
    uploadCache.set('edge', { id: 'f1', cachedAt: now - 5000 });
    assert.equal(uploadCache.sweep(now, 5000), 0);
    assert.equal(uploadCache.has('edge'), true);
});

test('upload-cache: sweep of an empty cache returns 0', () => {
    reset();
    assert.equal(uploadCache.sweep(Date.now(), 5000), 0);
});

test('upload-cache: getCache exposes the live map', () => {
    reset();
    uploadCache.getCache().set('direct', { id: 'f9' });
    assert.equal(uploadCache.has('direct'), true);
});

test('upload-cache: UPLOAD_CACHE_TTL_MS is a positive finite number', () => {
    assert.ok(Number.isFinite(uploadCache.UPLOAD_CACHE_TTL_MS));
    assert.ok(uploadCache.UPLOAD_CACHE_TTL_MS > 0);
});

test('upload-cache: sweep() honors a config.reload() of DS_UPLOAD_CACHE_TTL_MS', () => {
    // The default TTL is hours; reload it to something tiny and confirm sweep()
    // reads the live value rather than the load-time snapshot.
    reset();
    const now = Date.now();
    uploadCache.set('edge', { id: 'f1', cachedAt: now - 60_000 });
    process.env.DS_UPLOAD_CACHE_TTL_MS = '1';
    try {
        config.reload();
        assert.equal(uploadCache.sweep(now), 1, 'a 1ms live TTL must expire a 60s-old entry');
    } finally {
        delete process.env.DS_UPLOAD_CACHE_TTL_MS;
        config.reload();
    }
});
