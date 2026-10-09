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
        markAccountBroken, recordAccountRequest, hasAvailableAccount, waitForAvailableAccount,
        resetAccountState, accountStatePath, loadAccountState, serializeAccountState,
        persistAccountState, flushAccountState,
        getAccountById, accountIdFromCredentials } = accounts;

// --- helpers ----------------------------------------------------------------

// Point the shared config at a test upstream host. config.reload() takes the
// full env object, so the override is merged in WITHOUT mutating process.env
// (a global that would leak into the next test if this one threw).
function setRemoteHost(host) {
    config.reload({ DS_REMOTE_HOST: host });
}

afterEach(() => {
    // Restore module state after every test (accounts array + LRU timestamps).
    config.reload();
    const arr = getAccounts();
    arr.length = 0;
    resetAccountState();
});

function makeAccount(id, { token = 't', cookie = 'c', cooldownUntil = 0, failures = 0, lastUsedAt = 0, requestCount = 0, requestWindowStart = 0, nextCompletionAt = 0 } = {}) {
    return {
        id,
        file: `/tmp/${id}.json`,
        config: { token, cookie },
        headers: buildBaseHeaders({ token, cookie }),
        cooldownUntil,
        failures,
        lastUsedAt,
        requestCount,
        requestWindowStart,
        nextCompletionAt,
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
    // accounts.js reads the auth dir through lib/config.js, so pass it as a
    // reload override. No process.env mutation: a throw before the finally
    // block can no longer leak the temp dir into the next test.
    config.reload({ DS_AUTH_DIR: dir });
    try {
        return fn(dir);
    } finally {
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
    config.reload({ DS_CLIENT_LOCALE: 'en', DS_CLIENT_TIMEZONE_OFFSET: '3600' });
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
    config.reload({ DS_AUTH_DIR: '/definitely/not/a/dir/' + Date.now() });
    try {
        assert.deepEqual(discoverAuthPaths(), []);
    } finally {
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

// --- account state persistence ----------------------------------------------

test('loadDSConfig: restores a persisted future cooldown from .account-state.json', () => {
    const until = Date.now() + 3 * 60 * 60 * 1000;
    const id = accountIdFromCredentials({ token: 'T1', cookie: 'C1' });
    withTempAuthDir({
        'one.json': { token: 'T1', cookie: 'C1' },
        '.account-state.json': { version: 1, cooldowns: { [id]: until } },
    }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        const arr = getAccounts();
        assert.equal(arr.length, 1, 'the state file must not be loaded as an account');
        assert.equal(arr[0].cooldownUntil, until);
    });
});

test('loadDSConfig: restores lastUsedAt so LRU survives a restart', () => {
    const id = accountIdFromCredentials({ token: 'T1', cookie: 'C1' });
    const at = Date.now() - 5 * 60 * 1000;
    withTempAuthDir({
        'one.json': { token: 'T1', cookie: 'C1' },
        '.account-state.json': { version: 1, lastUsedAt: { [id]: at } },
    }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        assert.equal(getAccounts()[0].lastUsedAt, at);
    });
});

test('loadDSConfig: ignores an expired persisted cooldown', () => {
    const past = Date.now() - 1000;
    const id = accountIdFromCredentials({ token: 'T1', cookie: 'C1' });
    withTempAuthDir({
        'one.json': { token: 'T1', cookie: 'C1' },
        '.account-state.json': { version: 1, cooldowns: { [id]: past } },
    }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        assert.equal(getAccounts()[0].cooldownUntil, 0);
    });
});

test('loadDSConfig: a corrupt .account-state.json degrades to no state instead of failing', () => {
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' } }, (dir) => {
        fs.writeFileSync(path.join(dir, '.account-state.json'), '{ not json');
        assert.equal(loadDSConfig({ fatal: false }), true);
        assert.equal(getAccounts().length, 1);
        assert.equal(getAccounts()[0].cooldownUntil, 0);
    });
});

test('discoverAuthPaths: excludes the .account-state.json state file', () => {
    withTempAuthDir({
        'one.json': { token: 'T1', cookie: 'C1' },
        '.account-state.json': { version: 1, cooldowns: {} },
    }, () => {
        const names = discoverAuthPaths().map(p => path.basename(p));
        assert.deepEqual(names, ['one.json']);
    });
});

test('persistAccountState: writes future cooldowns, drops expired ones, keeps lastUsedAt', () => {
    const future = Date.now() + 60 * 60 * 1000;
    const past = Date.now() - 1000;
    const used = Date.now() - 30 * 1000;
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' } }, (dir) => {
        setAccounts([
            makeAccount('keep', { cooldownUntil: future, lastUsedAt: used }),
            makeAccount('drop', { cooldownUntil: past }),
        ]);
        persistAccountState();
        const written = JSON.parse(fs.readFileSync(path.join(dir, '.account-state.json'), 'utf8'));
        assert.deepEqual(written, { version: 1, cooldowns: { keep: future }, lastUsedAt: { keep: used } });
    });
});

test('persistAccountState: is a no-op when DS_AUTH_DIR is unset', () => {
    config.reload({ DS_AUTH_DIR: '' });
    try {
        assert.equal(accountStatePath(), null);
        // Must not throw even with no directory to write to.
        persistAccountState();
    } finally {
        config.reload();
    }
});

test('account state survives a write/load round-trip', () => {
    const until = Date.now() + 2 * 60 * 60 * 1000;
    const used = Date.now() - 45 * 1000;
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' } }, () => {
        setAccounts([makeAccount('a1', { cooldownUntil: until, lastUsedAt: used })]);
        persistAccountState();
        assert.deepEqual(loadAccountState(), { cooldowns: { a1: until }, lastUsedAt: { a1: used } });
    });
});

test('loadAccountState: returns empty maps when the state file does not exist', () => {
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' } }, () => {
        assert.deepEqual(loadAccountState(), { cooldowns: {}, lastUsedAt: {} });
    });
});

test('serializeAccountState: omits never-used accounts from lastUsedAt', () => {
    setAccounts([makeAccount('a1', { lastUsedAt: 0 })]);
    const parsed = JSON.parse(serializeAccountState());
    assert.deepEqual(parsed.lastUsedAt, {});
});

test('selectAccountForSession: a pick marks the account state dirty and a flush writes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-auth-'));
    fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify({ token: 'T1', cookie: 'C1' }));
    config.reload({ DS_AUTH_DIR: dir });
    try {
        setAccounts([makeAccount('a1')]);
        const session = { accountId: null };
        const picked = selectAccountForSession(session);
        assert.equal(picked.id, 'a1');
        // A synchronous flush must persist the freshly touched lastUsedAt.
        flushAccountState();
        const written = JSON.parse(fs.readFileSync(path.join(dir, '.account-state.json'), 'utf8'));
        assert.ok(written.lastUsedAt.a1 > 0);
    } finally {
        config.reload();
        fs.rmSync(dir, { recursive: true, force: true });
    }
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
    const env = { ...process.env };
    if (dir === null) delete env.DS_AUTH_DIR;
    else env.DS_AUTH_DIR = dir;
    config.reload(env);
    try {
        return fn();
    } finally {
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

test('selectAccountForSession: picks the least-recently-used ready account', () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    setAccounts([a1, a2]);
    const first = selectAccountForSession({ accountId: null });
    const second = selectAccountForSession({ accountId: null });
    const third = selectAccountForSession({ accountId: null });
    // No shared cursor: the oldest lastUsedAt always wins, so a fresh pair
    // still alternates a1 -> a2 -> a1 as each pick refreshes lastUsedAt.
    assert.deepEqual([first.id, second.id, third.id], ['a1', 'a2', 'a1']);
});

test('selectAccountForSession: prefers an idle account over a recently used one', () => {
    const now = Date.now();
    // a1 was used long ago, a2 a moment ago. LRU must pick a1 even though a2
    // comes first in load order.
    setAccounts([
        makeAccount('a1', { lastUsedAt: now - 60000 }),
        makeAccount('a2', { lastUsedAt: now - 1000 }),
    ]);
    assert.equal(selectAccountForSession({ accountId: null }).id, 'a1');
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

// --- recordAccountRequest ------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

test('recordAccountRequest: counts requests and does not park below the cap', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '5' });
    const a = makeAccount('a1');
    setAccounts([a]);
    const now = Date.now();
    for (let i = 0; i < 4; i++) recordAccountRequest(a, now + i);
    assert.equal(a.requestCount, 4);
    assert.equal(a.cooldownUntil, 0, 'under the cap the account stays available');
    assert.equal(hasAvailableAccount(), true);
});

test('recordAccountRequest: parks the account for the rest of the window at the cap', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '3' });
    const a = makeAccount('a1');
    setAccounts([a]);
    const now = 1_000_000;
    recordAccountRequest(a, now);
    recordAccountRequest(a, now + 1);
    assert.equal(a.cooldownUntil, 0, 'still available below the cap');
    recordAccountRequest(a, now + 2); // hits the cap
    assert.equal(a.requestCount, 3);
    assert.equal(a.cooldownUntil, now + HOUR_MS, 'parked until the window resets');
});

test('recordAccountRequest: resets the window once an hour has elapsed', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '2' });
    const a = makeAccount('a1', { requestCount: 2, requestWindowStart: 1000, cooldownUntil: 1000 + HOUR_MS });
    setAccounts([a]);
    recordAccountRequest(a, 1000 + HOUR_MS + 1);
    assert.equal(a.requestCount, 1);
    assert.equal(a.requestWindowStart, 1000 + HOUR_MS + 1);
});

test('recordAccountRequest: a limit of 0 disables the cap', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '0' });
    const a = makeAccount('a1');
    setAccounts([a]);
    for (let i = 0; i < 1000; i++) recordAccountRequest(a, Date.now());
    assert.equal(a.requestCount, 0, 'nothing is counted when the cap is disabled');
    assert.equal(a.cooldownUntil, 0);
});

test('recordAccountRequest: the hourly park makes selectAccountForSession rotate', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '1' });
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    setAccounts([a1, a2]);
    recordAccountRequest(a1); // a1 now parked for an hour
    assert.equal(selectAccountForSession({ accountId: null }).id, 'a2');
});

test('recordAccountRequest: ignores a missing account', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '1' });
    assert.doesNotThrow(() => recordAccountRequest(null));
    assert.doesNotThrow(() => recordAccountRequest(undefined));
});

test('recordAccountRequest: a later short cooldown does not shorten the hourly park', () => {
    config.reload({ DS_ACCOUNT_MAX_REQUESTS_PER_HOUR: '1' });
    const a = makeAccount('a1');
    setAccounts([a]);
    const now = Date.now();
    recordAccountRequest(a, now);
    const parkUntil = a.cooldownUntil;
    markAccountFailure(a, 429, 'rate limited', '1');
    assert.equal(a.cooldownUntil, parkUntil);
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

test('waitForAvailableAccount: stops early when the client is gone', async () => {
    setAccounts([makeAccount('a1', { cooldownUntil: Date.now() + 60000 })]);
    const start = Date.now();
    const ok = await waitForAvailableAccount(() => false, { maxWaitMs: 60000, pollMs: 10, clientGone: () => true });
    assert.equal(ok, false);
    assert.ok(Date.now() - start < 1000, 'should not wait out maxWaitMs when the client left');
});

// --- resetAccountState ------------------------------------------------------

test('resetAccountState: clears cooldowns, failures and lastUsedAt', () => {
    const a1 = makeAccount('a1', { failures: 3 });
    const a2 = makeAccount('a2', { failures: 1 });
    setAccounts([a1, a2]);
    // Use both accounts so each gets a non-zero lastUsedAt to observe resetting.
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


// --- waitForCompletionSlot --------------------------------------------------

// Deterministic clock + sleep recorder: no real time passes, so the throttle
// tests are fast and assert exact wait durations.
function fakeClock(t0 = 1_000_000) {
    let t = t0;
    const slept = [];
    return {
        now: () => t,
        sleep: async (ms) => { slept.push(ms); t += ms; },
        slept,
        advance: (ms) => { t += ms; },
    };
}

test('waitForCompletionSlot: no interval means no wait and no reservation', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();
    const ok = await accounts.waitForCompletionSlot(a, { intervalMs: 0, now: clock.now, sleep: clock.sleep });
    assert.equal(ok, true);
    assert.deepEqual(clock.slept, []);
    assert.equal(a.nextCompletionAt, 0);
});

test('waitForCompletionSlot: first call on a fresh account does not wait', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();
    const ok = await accounts.waitForCompletionSlot(a, { intervalMs: 5000, now: clock.now, sleep: clock.sleep });
    assert.equal(ok, true);
    assert.deepEqual(clock.slept, []);
    assert.equal(a.nextCompletionAt, clock.now() + 5000);
});

test('waitForCompletionSlot: second call waits out the interval since the first', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();
    await accounts.waitForCompletionSlot(a, { intervalMs: 5000, now: clock.now, sleep: clock.sleep });
    clock.advance(2000); // 2s of the 5s interval already elapsed
    await accounts.waitForCompletionSlot(a, { intervalMs: 5000, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(clock.slept, [3000]);
    assert.equal(a.nextCompletionAt, clock.now() + 5000);
});

test('waitForCompletionSlot: pressure stretches the reservation interval', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();
    // pressure 1.0 with factor 2 -> effective interval = 5000 * (1 + 2) = 15000.
    await accounts.waitForCompletionSlot(a, {
        intervalMs: 5000, pressure: 1, backoffFactor: 2, now: clock.now, sleep: clock.sleep,
    });
    assert.deepEqual(clock.slept, []);
    assert.equal(a.nextCompletionAt, clock.now() + 15000);
});

test('waitForCompletionSlot: pressure scales linearly and 0 preserves the base interval', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();
    // Half pressure with factor 2 -> 5000 * (1 + 1) = 10000.
    await accounts.waitForCompletionSlot(a, {
        intervalMs: 5000, pressure: 0.5, backoffFactor: 2, now: clock.now, sleep: clock.sleep,
    });
    assert.equal(a.nextCompletionAt, clock.now() + 10000);

    const b = makeAccount('a2');
    const clock2 = fakeClock();
    await accounts.waitForCompletionSlot(b, {
        intervalMs: 5000, pressure: 0, backoffFactor: 2, now: clock2.now, sleep: clock2.sleep,
    });
    assert.equal(b.nextCompletionAt, clock2.now() + 5000, 'no pressure -> base interval');
});

test('waitForCompletionSlot: pressure is clamped to [0,1] and factor 0 disables it', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();
    // Overshoot pressure is clamped to 1, so the interval is 3x, not 5x.
    await accounts.waitForCompletionSlot(a, {
        intervalMs: 5000, pressure: 4, backoffFactor: 2, now: clock.now, sleep: clock.sleep,
    });
    assert.equal(a.nextCompletionAt, clock.now() + 15000);

    const b = makeAccount('a2');
    const clock2 = fakeClock();
    await accounts.waitForCompletionSlot(b, {
        intervalMs: 5000, pressure: 1, backoffFactor: 0, now: clock2.now, sleep: clock2.sleep,
    });
    assert.equal(b.nextCompletionAt, clock2.now() + 5000, 'factor 0 -> adaptive part off');

    const c = makeAccount('a3');
    const clock3 = fakeClock();
    await accounts.waitForCompletionSlot(c, {
        intervalMs: 5000, pressure: -1, backoffFactor: 2, now: clock3.now, sleep: clock3.sleep,
    });
    assert.equal(c.nextCompletionAt, clock3.now() + 5000, 'negative pressure -> base interval');
});

test('waitForCompletionSlot: reserves the slot before sleeping (concurrent calls queue)', async () => {
    const a = makeAccount('a1');
    // A frozen clock so all three callers observe the same instant before
    // sleeping (mirrors three requests arriving together). Sleep only records,
    // it does not advance time, otherwise a later caller would measure its
    // start after an earlier caller's sleep.
    const t = 1_000_000;
    const slept = [];
    const opts = { intervalMs: 5000, now: () => t, sleep: async (ms) => { slept.push(ms); } };
    await Promise.all([
        accounts.waitForCompletionSlot(a, opts),
        accounts.waitForCompletionSlot(a, opts),
        accounts.waitForCompletionSlot(a, opts),
    ]);
    // Reserved up front, so the three callers wait 0, 5000 and 10000ms.
    assert.deepEqual(slept, [5000, 10000]);
});

test('waitForCompletionSlot: a long wait does not spend the whole deadline budget', async () => {
    const a = makeAccount('a1');
    a.nextCompletionAt = 0;
    const clock = fakeClock();
    await accounts.waitForCompletionSlot(a, { intervalMs: 5000, now: clock.now, sleep: clock.sleep });
    // Next slot is 5s out; a caller that only has 1s left must bail out.
    const ok = await accounts.waitForCompletionSlot(a, { intervalMs: 5000, maxWaitMs: 1000, now: clock.now, sleep: clock.sleep });
    assert.equal(ok, false);
    assert.deepEqual(clock.slept, []);
});

test('waitForCompletionSlot: deadlineHit and clientGone abort the wait', async () => {
    const a1 = makeAccount('a1');
    const clock1 = fakeClock();
    await accounts.waitForCompletionSlot(a1, { intervalMs: 5000, now: clock1.now, sleep: clock1.sleep });
    assert.equal(await accounts.waitForCompletionSlot(a1, { intervalMs: 5000, now: clock1.now, sleep: clock1.sleep, deadlineHit: () => true }), false);

    const a2 = makeAccount('a2');
    const clock2 = fakeClock();
    await accounts.waitForCompletionSlot(a2, { intervalMs: 5000, now: clock2.now, sleep: clock2.sleep });
    assert.equal(await accounts.waitForCompletionSlot(a2, { intervalMs: 5000, now: clock2.now, sleep: clock2.sleep, clientGone: () => true }), false);
});

test('resetAccountState clears nextCompletionAt too', () => {
    const a1 = makeAccount('a1');
    setAccounts([a1]);
    a1.nextCompletionAt = Date.now() + 60000;
    resetAccountState();
    assert.equal(a1.nextCompletionAt, 0);
});
