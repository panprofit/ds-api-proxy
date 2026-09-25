'use strict';
// Tests for lib/accounts.js. The module is a singleton that owns the mutable
// `accounts` array, so tests snapshot/restore that array around each case via
// `withAccounts`. No HTTP server or network is involved.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accounts = require('../lib/accounts');
const config = require('../lib/config');

const { getAccounts, buildBaseHeaders, discoverAuthPaths, loadDSConfig,
        hasAuthConfig, auditAuthDir, selectAccountForSession, markAccountFailure,
        markAccountBroken, hasAvailableAccount, waitForAvailableAccount,
        resetAccountState, setRemoteHost, getRemoteHost,
        getAccountById, accountIdFromCredentials } = accounts;

// --- helpers ----------------------------------------------------------------

const savedHost = getRemoteHost();

afterEach(() => {
    // Restore module state after every test (accounts array + round-robin cursor).
    setRemoteHost(savedHost);
    const arr = getAccounts();
    arr.length = 0;
    resetAccountState();
});

function makeAccount(id, { token = 't', cookie = 'c', cooldownUntil = 0, failures = 0 } = {}) {
    return {
        id,
        file: `/tmp/${id}.json`,
        config: { token, cookie },
        headers: buildBaseHeaders({ token, cookie }),
        cooldownUntil,
        failures,
        lastUsedAt: 0,
    };
}

function setAccounts(list) {
    const arr = getAccounts();
    arr.length = 0;
    arr.push(...list);
}

function withTempAuthDir(configs, fn) {
    // configs: { filename: object }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-auth-'));
    for (const [name, cfg] of Object.entries(configs)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(cfg));
    }
    const prev = process.env.DS_AUTH_DIR;
    process.env.DS_AUTH_DIR = dir;
    // accounts.js reads the auth dir through lib/config.js now, so the
    // injected env has to be re-parsed for the change to take effect.
    config.reload();
    try {
        return fn(dir);
    } finally {
        if (prev === undefined) delete process.env.DS_AUTH_DIR;
        else process.env.DS_AUTH_DIR = prev;
        config.reload();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// --- buildBaseHeaders -------------------------------------------------------

test('buildBaseHeaders: includes auth, cookies and the configured remote host', () => {
    setRemoteHost('example.test');
    const h = buildBaseHeaders({ token: 'TOK', cookie: 'a=b', hifDliq: 'DLIQ', hifLeim: 'LEIM' });
    assert.equal(h.Authorization, 'Bearer TOK');
    assert.equal(h.Cookie, 'a=b');
    assert.equal(h['x-hif-dliq'], 'DLIQ');
    assert.equal(h['x-hif-leim'], 'LEIM');
    assert.equal(h.Origin, 'https://example.test');
    assert.equal(h.Referer, 'https://example.test');
    assert.equal(h['Content-Type'], 'application/json');
});

test('buildBaseHeaders: tolerates an empty config', () => {
    const h = buildBaseHeaders({});
    assert.equal(h.Authorization, 'Bearer ');
    assert.equal(h.Cookie, '');
    assert.equal(h['x-hif-dliq'], '');
    assert.equal(h['x-hif-leim'], '');
});

test('buildBaseHeaders: uses DS_CLIENT_LOCALE/_TIMEZONE defaults, overridable per account', () => {
    const prevLocale = process.env.DS_CLIENT_LOCALE;
    const prevTz = process.env.DS_CLIENT_TIMEZONE_OFFSET;
    process.env.DS_CLIENT_LOCALE = 'en';
    process.env.DS_CLIENT_TIMEZONE_OFFSET = '3600';
    config.reload();
    try {
        const def = buildBaseHeaders({ token: 'T' });
        assert.equal(def['x-client-locale'], 'en');
        assert.equal(def['x-client-timezone-offset'], '3600');
        const overridden = buildBaseHeaders({ token: 'T', locale: 'de', timezone_offset: 7200 });
        assert.equal(overridden['x-client-locale'], 'de');
        assert.equal(overridden['x-client-timezone-offset'], '7200');
        // `0` is a legitimate override (an account at UTC), so it must win over
        // the global default instead of being treated as "unset" by `||`.
        const utc = buildBaseHeaders({ token: 'T', locale: 'en', timezone_offset: 0 });
        assert.equal(utc['x-client-locale'], 'en');
        assert.equal(utc['x-client-timezone-offset'], '0');
    } finally {
        if (prevLocale === undefined) delete process.env.DS_CLIENT_LOCALE;
        else process.env.DS_CLIENT_LOCALE = prevLocale;
        if (prevTz === undefined) delete process.env.DS_CLIENT_TIMEZONE_OFFSET;
        else process.env.DS_CLIENT_TIMEZONE_OFFSET = prevTz;
        config.reload();
    }
});

test('buildBaseHeaders: returns an empty-config header set when called without an argument', () => {
    // Regression: the argument used to default to the first loaded account,
    // so a bare buildBaseHeaders() silently produced another account's headers.
    setAccounts([makeAccount('a1', { token: 'TOK', cookie: 'c=1' })]);
    const h = buildBaseHeaders();
    assert.equal(h.Authorization, 'Bearer ');
    assert.equal(h.Cookie, '');
});

// --- discoverAuthPaths ------------------------------------------------------

test('discoverAuthPaths: reads sorted .json files from DS_AUTH_DIR', () => {
    withTempAuthDir({ 'b.json': {}, 'a.json': {}, 'notes.txt': {} }, (dir) => {
        const paths = discoverAuthPaths();
        assert.deepEqual(paths.map(p => path.basename(p)), ['a.json', 'b.json']);
        assert.ok(paths.every(p => p.startsWith(dir)));
    });
});

test('discoverAuthPaths: returns [] when DS_AUTH_DIR is unreadable', () => {
    const prev = process.env.DS_AUTH_DIR;
    process.env.DS_AUTH_DIR = '/definitely/not/a/dir/' + Date.now();
    config.reload();
    try {
        assert.deepEqual(discoverAuthPaths(), []);
    } finally {
        if (prev === undefined) delete process.env.DS_AUTH_DIR;
        else process.env.DS_AUTH_DIR = prev;
        config.reload();
    }
});

// --- loadDSConfig -----------------------------------------------------------

test('loadDSConfig: loads accounts, assigns credential-hash ids, and sets headers', () => {
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' }, 'two.json': { token: 'T2', cookie: 'C2' } }, () => {
        const ok = loadDSConfig({ fatal: false });
        assert.equal(ok, true);
        const arr = getAccounts();
        assert.equal(arr.length, 2);
        // Ids are a hash of token+cookie, stable across reloads, not a load-order index.
        assert.deepEqual(arr.map(a => a.id), [
            accountIdFromCredentials({ token: 'T1', cookie: 'C1' }),
            accountIdFromCredentials({ token: 'T2', cookie: 'C2' }),
        ]);
        assert.equal(arr[0].config.token, 'T1');
        assert.equal(arr[0].headers.Authorization, 'Bearer T1');
        assert.equal(arr[0].cooldownUntil, 0);
        assert.equal(arr[0].failures, 0);
    });
});

test('loadDSConfig: skips a file whose credentials duplicate an already-loaded account', () => {
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' }, 'dup.json': { token: 'T1', cookie: 'C1' } }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        const arr = getAccounts();
        assert.equal(arr.length, 1);
        assert.equal(arr[0].config.token, 'T1');
    });
});

test('accountIdFromCredentials: is stable and independent of token/cookie order in the object', () => {
    const a = accountIdFromCredentials({ token: 'T', cookie: 'C' });
    const b = accountIdFromCredentials({ cookie: 'C', token: 'T' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.notEqual(a, accountIdFromCredentials({ token: 'T', cookie: 'C2' }));
});

test('loadDSConfig: skips malformed json files but keeps the good ones', () => {
    withTempAuthDir({ 'good.json': { token: 'G', cookie: 'C' } }, (dir) => {
        fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
        const ok = loadDSConfig({ fatal: false });
        assert.equal(ok, true);
        assert.equal(getAccounts().length, 1);
        assert.equal(getAccounts()[0].config.token, 'G');
    });
});

test('loadDSConfig: skips a config missing token/cookie instead of loading a dead account', () => {
    withTempAuthDir({
        'good.json': { token: 'G', cookie: 'C' },
        'no-token.json': { cookie: 'C' },
        'no-cookie.json': { token: 'T' },
    }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        const arr = getAccounts();
        assert.equal(arr.length, 1);
        assert.equal(arr[0].config.token, 'G');
    });
});

test('loadDSConfig: returns false with fatal=false when nothing loads', () => {
    withTempAuthDir({}, () => {
        assert.equal(loadDSConfig({ fatal: false }), false);
        assert.equal(getAccounts().length, 0);
    });
});

// --- hasAuthConfig ----------------------------------------------------------

test('hasAuthConfig: true only when token AND cookie are present', () => {
    setAccounts([
        makeAccount('a1', { token: 't', cookie: 'c' }),
        makeAccount('a2', { token: 't', cookie: '' }),
    ]);
    assert.equal(hasAuthConfig(), true);
    setAccounts([makeAccount('a2', { token: 't', cookie: '' })]);
    assert.equal(hasAuthConfig(), false);
    setAccounts([]);
    assert.equal(hasAuthConfig(), false);
});

// --- auditAuthDir -----------------------------------------------------------

// withEnvDir runs `fn` with DS_AUTH_DIR pointed at `dir` (or unset when dir is
// null), reloading the central config so auditAuthDir() sees the change.
function withEnvDir(dir, fn) {
    const prev = process.env.DS_AUTH_DIR;
    if (dir === null) delete process.env.DS_AUTH_DIR;
    else process.env.DS_AUTH_DIR = dir;
    config.reload();
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.DS_AUTH_DIR;
        else process.env.DS_AUTH_DIR = prev;
        config.reload();
    }
}

test('auditAuthDir: ok when the dir exists and accounts loaded', () => {
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' } }, () => {
        loadDSConfig({ fatal: false });
        const report = auditAuthDir();
        assert.equal(report.level, 'ok');
        assert.match(report.message, /1 auth account\(s\) loaded/);
    });
});

test('auditAuthDir: error when DS_AUTH_DIR is unset', () => {
    withEnvDir(null, () => {
        const report = auditAuthDir();
        assert.equal(report.level, 'error');
        assert.equal(report.reason, 'unset');
    });
});

test('auditAuthDir: error when the dir does not exist', () => {
    withEnvDir('/definitely/not/a/dir/' + Date.now(), () => {
        const report = auditAuthDir();
        assert.equal(report.level, 'error');
        assert.equal(report.reason, 'missing');
    });
});

test('auditAuthDir: error when the path is not a directory', () => {
    const file = path.join(os.tmpdir(), `ds-auth-file-${Date.now()}`);
    fs.writeFileSync(file, 'x');
    try {
        withEnvDir(file, () => {
            const report = auditAuthDir();
            assert.equal(report.level, 'error');
            assert.equal(report.reason, 'not-a-directory');
        });
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('auditAuthDir: warn when the dir has no *.json configs', () => {
    withTempAuthDir({}, (dir) => {
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
        loadDSConfig({ fatal: false });
        const report = auditAuthDir();
        assert.equal(report.level, 'warn');
        assert.equal(report.reason, 'no-configs');
    });
});

test('auditAuthDir: error when configs exist but none loaded', () => {
    withTempAuthDir({ 'bad.json': { cookie: 'C' } }, () => {
        loadDSConfig({ fatal: false });
        const report = auditAuthDir();
        assert.equal(report.level, 'error');
        assert.equal(report.reason, 'all-invalid');
    });
});

// --- selectAccountForSession ------------------------------------------------

test('selectAccountForSession: returns the sticky account when healthy', () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    setAccounts([a1, a2]);
    const session = { accountId: 'a2' };
    const picked = selectAccountForSession(session);
    assert.equal(picked, a2);
    assert.equal(session.accountId, 'a2');
});

test('selectAccountForSession: drops a sticky account that is cooling down and resets the session', () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2', { cooldownUntil: Date.now() + 60000 });
    setAccounts([a1, a2]);
    let resetCalled = 0;
    const session = { accountId: 'a2' };
    const picked = selectAccountForSession(session, { resetRemoteSession: () => { resetCalled++; } });
    assert.equal(picked, a1);
    assert.equal(resetCalled, 1, 'resetRemoteSession should be invoked for the broken sticky account');
    assert.equal(session.accountId, 'a1');
});

test('selectAccountForSession: round-robins across ready accounts', () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    setAccounts([a1, a2]);
    const first = selectAccountForSession({ accountId: null });
    const second = selectAccountForSession({ accountId: null });
    const third = selectAccountForSession({ accountId: null });
    assert.deepEqual([first.id, second.id, third.id], ['a1', 'a2', 'a1']);
});

test('selectAccountForSession: skips accounts that are cooling down', () => {
    const cold = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    const warm = makeAccount('a2');
    setAccounts([cold, warm]);
    for (let i = 0; i < 3; i++) {
        assert.equal(selectAccountForSession({ accountId: null }), warm);
    }
});

test('selectAccountForSession: throws 429 when every account is cooling down', () => {
    setAccounts([
        makeAccount('a1', { cooldownUntil: Date.now() + 60000 }),
        makeAccount('a2', { cooldownUntil: Date.now() + 30000 }),
    ]);
    assert.throws(() => selectAccountForSession({ accountId: null }), (err) => {
        assert.equal(err.status, 429);
        // Unified with the recovery loop's "all accounts cooling" body: both
        // now use the shared 429 -> rate_limit_error mapping.
        assert.equal(err.type, 'rate_limit_error');
        assert.ok(err.retryAfter >= 1);
        return true;
    });
});

test('selectAccountForSession: throws 503 when no account has usable credentials', () => {
    setAccounts([
        makeAccount('a1', { token: '', cookie: '' }),
        makeAccount('a2', { token: 't', cookie: '' }),
    ]);
    assert.throws(() => selectAccountForSession({ accountId: null }), (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.type, 'no_auth');
        return true;
    });
});

// --- markAccountFailure -----------------------------------------------------

test('markAccountFailure: cools down on 401/403/429 and counts the failure', () => {
    const a = makeAccount('a1');
    setAccounts([a]);
    markAccountFailure(a, 401, 'unauthorized');
    assert.equal(a.failures, 1);
    assert.ok(a.cooldownUntil > Date.now());
});

test('markAccountFailure: uses Retry-After for 429', () => {
    const a = makeAccount('a1');
    setAccounts([a]);
    const before = Date.now();
    markAccountFailure(a, 429, 'rate limited', '2');
    const expected = before + 2000;
    assert.ok(Math.abs(a.cooldownUntil - expected) < 500, `expected ~${expected}, got ${a.cooldownUntil}`);
});

test('markAccountFailure: does not cool down on other statuses', () => {
    const a = makeAccount('a1');
    setAccounts([a]);
    markAccountFailure(a, 500, 'server error');
    assert.equal(a.failures, 1);
    assert.equal(a.cooldownUntil, 0);
});

test('markAccountFailure: is a no-op for a missing account', () => {
    assert.doesNotThrow(() => markAccountFailure(null, 429));
    assert.doesNotThrow(() => markAccountFailure(undefined, 429));
});

// --- markAccountBroken ------------------------------------------------------

test('markAccountBroken: always applies at least a 1s cooldown', () => {
    const a = makeAccount('a1');
    setAccounts([a]);
    const before = Date.now();
    markAccountBroken(a, 'empty response', 0);
    assert.equal(a.failures, 1);
    assert.ok(a.cooldownUntil >= before + 1000);
});

test('markAccountBroken: honors the requested cooldown window', () => {
    const a = makeAccount('a1');
    setAccounts([a]);
    const before = Date.now();
    markAccountBroken(a, 'malformed markup', 5000);
    const expected = before + 5000;
    assert.ok(Math.abs(a.cooldownUntil - expected) < 500);
});

// --- hasAvailableAccount ----------------------------------------------------

test('hasAvailableAccount: true only for ready accounts that are not cooling down', () => {
    setAccounts([makeAccount('a1', { cooldownUntil: Date.now() + 60000 })]);
    assert.equal(hasAvailableAccount(), false);
    setAccounts([makeAccount('a1'), makeAccount('a2', { cooldownUntil: Date.now() + 60000 })]);
    assert.equal(hasAvailableAccount(), true);
    setAccounts([makeAccount('a1', { token: '', cookie: '' })]);
    assert.equal(hasAvailableAccount(), false);
    setAccounts([]);
    assert.equal(hasAvailableAccount(), false);
});

// --- waitForAvailableAccount ------------------------------------------------

test('waitForAvailableAccount: returns true immediately when an account is ready', async () => {
    setAccounts([makeAccount('a1')]);
    const ok = await waitForAvailableAccount(() => false, { maxWaitMs: 1000, pollMs: 10 });
    assert.equal(ok, true);
});

test('waitForAvailableAccount: returns false when the deadline is already hit', async () => {
    setAccounts([makeAccount('a1', { cooldownUntil: Date.now() + 60000 })]);
    const ok = await waitForAvailableAccount(() => true, { maxWaitMs: 1000, pollMs: 10 });
    assert.equal(ok, false);
});

test('waitForAvailableAccount: resolves true as soon as a cooldown expires', async () => {
    const a = makeAccount('a1', { cooldownUntil: Date.now() + 60 });
    setAccounts([a]);
    const ok = await waitForAvailableAccount(() => false, { maxWaitMs: 2000, pollMs: 10 });
    assert.equal(ok, true);
});

test('waitForAvailableAccount: gives up after maxWaitMs if nothing becomes available', async () => {
    setAccounts([makeAccount('a1', { cooldownUntil: Date.now() + 60000 })]);
    const start = Date.now();
    const ok = await waitForAvailableAccount(() => false, { maxWaitMs: 60, pollMs: 10 });
    assert.equal(ok, false);
    assert.ok(Date.now() - start >= 50, 'should have waited roughly maxWaitMs');
});

// --- resetAccountState ------------------------------------------------------

test('resetAccountState: clears cooldowns, failures and the round-robin cursor', () => {
    const a1 = makeAccount('a1', { failures: 3 });
    const a2 = makeAccount('a2', { failures: 1 });
    setAccounts([a1, a2]);
    // Advance the round-robin cursor so we can observe it resetting.
    assert.equal(selectAccountForSession({ accountId: null }).id, 'a1');
    assert.equal(selectAccountForSession({ accountId: null }).id, 'a2');
    // Now cool both down and reset: everything should come back to a clean slate.
    a1.cooldownUntil = Date.now() + 60000;
    a2.cooldownUntil = Date.now() + 60000;
    resetAccountState();
    assert.equal(a1.cooldownUntil, 0);
    assert.equal(a2.cooldownUntil, 0);
    assert.equal(a1.failures, 0);
    assert.equal(a2.failures, 0);
    // After reset the first pick is a1 again.
    assert.equal(selectAccountForSession({ accountId: null }).id, 'a1');
});

// --- getAccountById ---------------------------------------------------------

test('getAccountById: finds by id and returns undefined for unknown ids', () => {
    const a1 = makeAccount('a1');
    setAccounts([a1]);
    assert.equal(getAccountById('a1'), a1);
    assert.equal(getAccountById('nope'), undefined);
});

