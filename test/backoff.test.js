'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');
const { retryBaseMs, exponentialBackoffMs, linearBackoffMs } = require('../lib/backoff');

afterEach(() => config.reload());

test('retryBaseMs: tracks DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS', () => {
    config.reload({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '2500' });
    assert.equal(retryBaseMs(), 2500);
});

test('exponentialBackoffMs: doubles on every consecutive attempt', () => {
    assert.equal(exponentialBackoffMs(1, 100), 100);
    assert.equal(exponentialBackoffMs(2, 100), 200);
    assert.equal(exponentialBackoffMs(3, 100), 400);
    assert.equal(exponentialBackoffMs(4, 100), 800);
    assert.equal(exponentialBackoffMs(0, 100), 100);
});

test('linearBackoffMs: grows by one base step per consecutive streak', () => {
    assert.equal(linearBackoffMs(0, 6000), 6000);
    assert.equal(linearBackoffMs(1, 6000), 12000);
    assert.equal(linearBackoffMs(2, 6000), 18000);
    assert.equal(linearBackoffMs(3, 6000), 24000);
});

test('linearBackoffMs: uses the configured base by default', () => {
    config.reload({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '100' });
    assert.equal(linearBackoffMs(2), 300);
});
