'use strict';
// Unit tests for lib/account-status.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRetryAfterMs } = require('../lib/account-status');

// --- parseRetryAfterMs ------------------------------------------------------

test('parseRetryAfterMs: null for falsy input', () => {
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs(''), null);
});

test('parseRetryAfterMs: numeric seconds -> ms with a 1s floor', () => {
    assert.equal(parseRetryAfterMs('5'), 5000);
    assert.equal(parseRetryAfterMs('0'), 1000);
    assert.equal(parseRetryAfterMs('1'), 1000);
});

test('parseRetryAfterMs: HTTP-date is converted to ms until that time', () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms >= 1000 && ms <= 3500, `expected ~3000ms, got ${ms}`);
});

test('parseRetryAfterMs: past HTTP-date is floored to 1s', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    assert.equal(parseRetryAfterMs(past), 1000);
});

test('parseRetryAfterMs: unparseable value returns null', () => {
    assert.equal(parseRetryAfterMs('not-a-date'), null);
});
