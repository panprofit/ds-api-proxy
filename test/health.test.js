'use strict';
// Unit tests for lib/health.js. The report is built from injected inputs, so
// no auth config, sockets or real accounts are involved.

const test = require('node:test');
const assert = require('node:assert/strict');

const health = require('../lib/health');

function acct({ token = 't', cookie = 'c', cooldownUntil = 0 } = {}) {
    return { config: { token, cookie }, cooldownUntil };
}

// Minimal stand-in for the semaphore's read-only getters.
function sem(inFlight, limit) {
    return { inFlight, limit, available: limit - inFlight };
}

// A response stub that records writeHead(status, headers) and the body.
function fakeRes() {
    return {
        statusCode: null,
        headers: null,
        body: null,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(body) { this.body = body; },
    };
}

// --- buildHealthReport ------------------------------------------------------

test('buildHealthReport: defaults are safe with no arguments', () => {
    const report = health.buildHealthReport();
    assert.equal(report.status, 'ok');
    assert.equal(report.shutting_down, false);
    assert.equal(typeof report.accounts.total, 'number');
    assert.equal(report.uptime_ms, 0);          // startedAt defaults to 0
    assert.equal(report.concurrency, undefined); // no semaphore passed
});

test('buildHealthReport: counts usable vs available vs cooling accounts', () => {
    const now = 1_000_000;
    const report = health.buildHealthReport({
        accounts: [
            acct({ cooldownUntil: 0 }),                 // usable + available
            acct({ cooldownUntil: now + 5000 }),        // usable + cooling
            acct({ token: '', cookie: '' }),            // not usable
        ],
        now,
    });
    assert.deepEqual(report.accounts, { total: 3, usable: 2, available: 1, cooling: 1 });
});

test('buildHealthReport: an account is available exactly at its cooldown boundary', () => {
    const now = 1000;
    const report = health.buildHealthReport({ accounts: [acct({ cooldownUntil: 1000 })], now });
    assert.equal(report.accounts.available, 1, 'cooldownUntil == now counts as available');
    assert.equal(report.accounts.cooling, 0);
});

test('buildHealthReport: tolerates null/undefined entries in the accounts list', () => {
    const report = health.buildHealthReport({ accounts: [null, undefined, acct()] });
    assert.equal(report.accounts.total, 3);
    assert.equal(report.accounts.usable, 1);
});

test('buildHealthReport: reports the semaphore concurrency when provided', () => {
    const report = health.buildHealthReport({ semaphore: sem(3, 24) });
    assert.deepEqual(report.concurrency, { in_flight: 3, limit: 24, available: 21 });
});

test('buildHealthReport: uptime is computed from startedAt and floored at 0', () => {
    assert.equal(health.buildHealthReport({ startedAt: 1000, now: 1500 }).uptime_ms, 500);
    // A clock that went backwards must not report negative uptime.
    assert.equal(health.buildHealthReport({ startedAt: 2000, now: 1500 }).uptime_ms, 0);
});

test('buildHealthReport: reflects the shutdown flag and remote host', () => {
    const report = health.buildHealthReport({ shuttingDown: true, remoteHost: 'chat.deepseek.com' });
    assert.equal(report.status, 'shutting_down');
    assert.equal(report.shutting_down, true);
    assert.equal(report.remote_host, 'chat.deepseek.com');
    assert.equal(health.buildHealthReport({ remoteHost: '' }).remote_host, null);
});

test('buildHealthReport: a non-detailed report exposes only readiness', () => {
    const report = health.buildHealthReport({
        accounts: [acct()], sessionCount: 9, semaphore: sem(1, 24),
        remoteHost: 'chat.deepseek.com', startedAt: 1000, now: 1500,
        detailed: false,
    });
    assert.deepEqual(report, { status: 'ok', shutting_down: false });
});

test('buildHealthReport: a non-detailed report still reflects shutdown', () => {
    const report = health.buildHealthReport({ shuttingDown: true, detailed: false });
    assert.deepEqual(report, { status: 'shutting_down', shutting_down: true });
});

// --- handleHealth -----------------------------------------------------------

test('handleHealth: writes 200 + JSON and a no-store cache header while healthy', () => {
    const res = fakeRes();
    health.handleHealth(null, res, { accounts: [acct()], sessionCount: 4, semaphore: sem(0, 24), startedAt: 0 });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['Content-Length'], Buffer.byteLength(res.body));
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.sessions, 4);
});

test('handleHealth: writes 503 while shutting down', () => {
    const res = fakeRes();
    health.handleHealth(null, res, { shuttingDown: true });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).status, 'shutting_down');
});

test('handleHealth: a non-loopback peer gets only the minimal readiness report', () => {
    const res = fakeRes();
    health.handleHealth({ socket: { remoteAddress: '203.0.113.5' } }, res, {
        accounts: [acct()], sessionCount: 4, semaphore: sem(0, 24), remoteHost: 'chat.deepseek.com',
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok', shutting_down: false });
});

test('handleHealth: a loopback peer gets the detailed report', () => {
    const res = fakeRes();
    health.handleHealth({ socket: { remoteAddress: '127.0.0.1' } }, res, {
        accounts: [acct()], sessionCount: 4, semaphore: sem(0, 24),
    });
    const body = JSON.parse(res.body);
    assert.equal(body.sessions, 4);
    assert.ok(body.concurrency);
    assert.ok(body.accounts);
});

test('handleHealth: an explicit detailed flag overrides the peer lookup', () => {
    const res = fakeRes();
    health.handleHealth({ socket: { remoteAddress: '203.0.113.5' } }, res, { detailed: true, sessionCount: 7 });
    assert.equal(JSON.parse(res.body).sessions, 7);
});
