'use strict';
// Unit tests for the centralized config module.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');

test('config.load: defaults when env is empty', () => {
    const c = config.load({});
    assert.equal(c.port, 9876);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.remoteHost, '');
    assert.equal(c.maxConcurrent, 24);
    assert.equal(c.requestDeadlineMs, 120000);
    assert.equal(c.maxEmptyRetries, 2);
    assert.equal(c.maxUpstreamRetries, 3);
    assert.equal(c.malformedToolCallCooldownMs, 5000);
    assert.equal(c.accountCooldownMs, 10 * 60 * 1000);
    assert.equal(c.sessionTtlMs, 2 * 60 * 60 * 1000);
    assert.equal(c.maxSessions, 1000);
    assert.equal(c.fetchTimeoutMs, 60000);
    assert.equal(c.maxUploadBytes, 25 * 1024 * 1024);
    assert.equal(c.maxSessionResetsPerAccount, 3);
    assert.equal(c.shutdownGraceMs, 15000);
});

test('config.load: parses and overrides from env', () => {
    const c = config.load({
        PORT: '9999',
        HOST: '0.0.0.0',
        DS_REMOTE_HOST: 'example.com',
        DS_MAX_CONCURRENT: '5',
        DS_REQUEST_DEADLINE_MS: '1000',
        DS_MAX_RETRIES: '7',
        DS_MALFORMED_TOOL_CALL_COOLDOWN_MS: '250',
        DS_SESSION_TTL_MS: '1234',
        DS_AUTH_DIR: '/auth',
    });
    assert.equal(c.port, 9999);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.remoteHost, 'example.com');
    assert.equal(c.maxConcurrent, 5);
    assert.equal(c.requestDeadlineMs, 1000);
    assert.equal(c.maxEmptyRetries, 7);
    assert.equal(c.malformedToolCallCooldownMs, 250);
    assert.equal(c.sessionTtlMs, 1234);
    assert.equal(c.authDir, '/auth');
});

test('config.load: clamps maxEmptyRetries to [0,10]', () => {
    assert.equal(config.load({ DS_MAX_RETRIES: '99' }).maxEmptyRetries, 10);
    assert.equal(config.load({ DS_MAX_RETRIES: '-5' }).maxEmptyRetries, 0);
    assert.equal(config.load({ DS_MAX_RETRIES: 'not-a-number' }).maxEmptyRetries, 2);
});

test('config.load: ignores non-numeric values, keeps defaults', () => {
    const c = config.load({ PORT: 'abc', DS_MAX_CONCURRENT: 'x' });
    assert.equal(c.port, 9876);
    assert.equal(c.maxConcurrent, 24);
});

test('config.get / reload round-trip', () => {
    const before = config.get();
    const reloaded = config.reload({ PORT: '1234' });
    assert.equal(reloaded.port, 1234);
    assert.equal(config.get().port, 1234);
    // restore
    config.reload({});
    assert.ok(before);
});

test('config.load: body-read and socket-timeout defaults', () => {
    const c = config.load({});
    assert.equal(c.bodyReadTimeoutMs, 30000);
    assert.equal(c.headersTimeoutMs, 60000);
    assert.equal(c.requestTimeoutMs, 300000);
});

test('config.load: shutdownGraceMs honors override and clamps to >= 1000', () => {
    assert.equal(config.load({}).shutdownGraceMs, 15000);
    assert.equal(config.load({ DS_SHUTDOWN_GRACE_MS: '30000' }).shutdownGraceMs, 30000);
    assert.equal(config.load({ DS_SHUTDOWN_GRACE_MS: '5' }).shutdownGraceMs, 1000);
    assert.equal(config.load({ DS_SHUTDOWN_GRACE_MS: 'nope' }).shutdownGraceMs, 15000);
});
