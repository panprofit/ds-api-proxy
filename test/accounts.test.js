'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accounts = require('../lib/accounts');
const config = require('../lib/config');

const { getAccounts, buildBaseHeaders, setAccountToken, discoverAuthPaths, loadDSConfig,
        hasAuthConfig, auditAuthDir, selectAccountForSession, markAccountFailure,
        markAccountBroken, markAccountAuthExpired, hasAvailableAccount, waitForAvailableAccount,
        resetAccountState, accountStatePath, loadAccountState, serializeAccountState,
        persistAccountState, flushAccountState,
        getAccountById, accountIdFromCredentials, accountIdFromEmail, accountIdForConfig, persistAccountToken } = accounts;

afterEach(() => {

    config.reload();
    const arr = getAccounts();
    arr.length = 0;
    resetAccountState();
});

function makeAccount(id, { token = 't', cookie = 'c', cooldownUntil = 0, failures = 0, lastUsedAt = 0, nextCompletionAt = 0, authExpired = false } = {}) {
    return {
        id,
        file: `/tmp/${id}.json`,
        config: { token, cookie },
        headers: buildBaseHeaders({ token, cookie }),
        cooldownUntil,
        failures,
        lastUsedAt,
        nextCompletionAt,
        authExpired,
    };
}

function setAccounts(list) {
    const arr = getAccounts();
    arr.length = 0;
    arr.push(...list);
}

function withTempAuthDir(configs, fn) {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-auth-'));
    for (const [name, cfg] of Object.entries(configs)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(cfg));
    }

    config.reload({ DS_AUTH_DIR: dir });
    try {
        return fn(dir);
    } finally {
        config.reload();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('buildBaseHeaders: includes auth, cookies and the fixed upstream host', () => {
    const h = buildBaseHeaders({ token: 'TOK', cookie: 'a=b' });
    assert.equal(h.Authorization, 'Bearer TOK');
    assert.equal(h.Cookie, 'a=b');
    assert.equal(h.Referer, h.Origin);
    assert.equal(h['Content-Type'], 'application/json');
});

test('buildBaseHeaders: tolerates an empty config', () => {
    const h = buildBaseHeaders({});
    assert.equal(h.Authorization, 'Bearer ');
    assert.equal(h.Cookie, '');
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

        const utc = buildBaseHeaders({ token: 'T', locale: 'en', timezone_offset: 0 });
        assert.equal(utc['x-client-locale'], 'en');
        assert.equal(utc['x-client-timezone-offset'], '0');
    } finally {
        config.reload();
    }
});

test('setAccountToken: updates token and header, keeps the credential-derived id', () => {
    const a = makeAccount('stable-id', { token: 'OLD' });
    assert.equal(setAccountToken(a, 'NEW'), true);
    assert.equal(a.id, 'stable-id');
    assert.equal(a.config.token, 'NEW');
    assert.equal(a.headers.Authorization, 'Bearer NEW');
    assert.equal(setAccountToken(a, 'NEW'), false);
    assert.equal(setAccountToken(a, ''), false);
});

test('persistAccountToken: writes the rotated token back for email-keyed accounts', () => {
    withTempAuthDir({ 'a.json': { email: 'u@e.com', token: 'OLD', cookie: 'c=1', wasmUrl: 'w' } }, (dir) => {
        const file = path.join(dir, 'a.json');
        const account = { id: 'x', file, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
        setAccountToken(account, 'NEW');
        assert.equal(persistAccountToken(account), true);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(saved.token, 'NEW');
        assert.equal(saved.email, 'u@e.com');
        assert.equal(saved.cookie, 'c=1');
        assert.equal(saved.wasmUrl, 'w');
    });
});

test('persistAccountToken: legacy token+cookie-keyed accounts stay in memory only', () => {
    withTempAuthDir({ 'a.json': { token: 'OLD', cookie: 'c=1' } }, (dir) => {
        const account = { id: 'x', file: path.join(dir, 'a.json'), config: { token: 'NEW', cookie: 'c=1' } };
        assert.equal(persistAccountToken(account), false);
        assert.equal(JSON.parse(fs.readFileSync(account.file, 'utf8')).token, 'OLD');
    });
});

test('persistAccountToken: a write failure is reported, not thrown', () => {
    const account = { id: 'x', file: '/nonexistent-dir/a.json', config: { email: 'u@e.com', token: 'T', cookie: 'c' } };
    assert.equal(persistAccountToken(account), false);
});

test('buildBaseHeaders: returns an empty-config header set when called without an argument', () => {

    setAccounts([makeAccount('a1', { token: 'TOK', cookie: 'c=1' })]);
    const h = buildBaseHeaders();
    assert.equal(h.Authorization, 'Bearer ');
    assert.equal(h.Cookie, '');
});

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

test('loadDSConfig: loads accounts, assigns credential-hash ids, and sets headers', () => {
    withTempAuthDir({ 'one.json': { token: 'T1', cookie: 'C1' }, 'two.json': { token: 'T2', cookie: 'C2' } }, () => {
        const ok = loadDSConfig({ fatal: false });
        assert.equal(ok, true);
        const arr = getAccounts();
        assert.equal(arr.length, 2);

        assert.deepEqual(arr.map(a => a.id), [
            accountIdFromCredentials({ token: 'T1', cookie: 'C1' }),
            accountIdFromCredentials({ token: 'T2', cookie: 'C2' }),
        ]);
        assert.equal(arr[0].config.token, 'T1');
        assert.equal(arr[0].headers.Authorization, 'Bearer T1');
        assert.equal(arr[0].cooldownUntil, 0);
        assert.equal(arr[0].failures, 0);
        assert.equal(arr[0].authExpired, false);
    });
});

test('loadDSConfig: keys accounts by the email hash when the file records one', () => {
    withTempAuthDir({
        'one.json': { email: 'User@Example.com', token: 'T1', cookie: 'C1' },
        'two.json': { email: 'other@example.com', token: 'T2', cookie: 'C2' },
    }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        assert.deepEqual(getAccounts().map(a => a.id), [
            accountIdFromEmail('User@Example.com'),
            accountIdFromEmail('other@example.com'),
        ]);
    });
});

test('loadDSConfig: two files with the same email collapse to one account', () => {
    withTempAuthDir({
        'one.json': { email: 'user@example.com', token: 'T1', cookie: 'C1' },
        'dup.json': { email: ' USER@example.com ', token: 'T2', cookie: 'C2' },
    }, () => {
        assert.equal(loadDSConfig({ fatal: false }), true);
        assert.equal(getAccounts().length, 1);
    });
});

test('accountIdFromEmail: stable across token changes and case/whitespace', () => {
    const a = accountIdFromEmail('User@Example.com');
    assert.equal(a, accountIdFromEmail(' user@example.COM '));
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(accountIdFromEmail(''), '');
    assert.notEqual(a, accountIdFromEmail('other@example.com'));
});

test('accountIdForConfig: prefers email and falls back to credentials', () => {
    assert.equal(accountIdForConfig({ email: 'u@e.com', token: 'T', cookie: 'C' }), accountIdFromEmail('u@e.com'));
    assert.equal(accountIdForConfig({ token: 'T', cookie: 'C' }), accountIdFromCredentials({ token: 'T', cookie: 'C' }));
    assert.equal(accountIdForConfig({ email: '   ', token: 'T', cookie: 'C' }), accountIdFromCredentials({ token: 'T', cookie: 'C' }));
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

test('persistAccountState: resolves a path for the defaulted auth dir', () => {
    config.reload({});
    try {
        assert.equal(accountStatePath(), path.join('./.auth', '.account-state.json'));
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

test('serializeAccountState: does not persist a cooldown for an auth-expired account', () => {
    setAccounts([makeAccount('a1', { authExpired: true, cooldownUntil: Date.now() + 300000 })]);
    const parsed = JSON.parse(serializeAccountState());
    assert.deepEqual(parsed.cooldowns, {});
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

        flushAccountState();
        const written = JSON.parse(fs.readFileSync(path.join(dir, '.account-state.json'), 'utf8'));
        assert.ok(written.lastUsedAt.a1 > 0);
    } finally {
        config.reload();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

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

test('auditAuthDir: reports on the defaulted auth dir when DS_AUTH_DIR is unset', () => {
    const env = { ...process.env };
    delete env.DS_AUTH_DIR;
    config.reload(env);
    try {
        const report = auditAuthDir();

        assert.equal(report.message.includes('./.auth'), true);
        assert.equal(report.reason, 'no-configs');
    } finally {
        config.reload();
    }
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

    assert.deepEqual([first.id, second.id, third.id], ['a1', 'a2', 'a1']);
});

test('selectAccountForSession: forceLru ignores a healthy sticky account', () => {
    const a1 = makeAccount('a1', { lastUsedAt: Date.now() - 60000 });
    const a2 = makeAccount('a2', { lastUsedAt: Date.now() - 1000 });
    setAccounts([a1, a2]);

    const session = { accountId: 'a2' };
    const picked = selectAccountForSession(session, { forceLru: true });
    assert.equal(picked, a1);
    assert.equal(session.accountId, 'a1');
});

test('selectAccountForSession: prefers an idle account over a recently used one', () => {
    const now = Date.now();

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

test('selectAccountForSession: skips accounts disabled by an auth failure', () => {
    const expired = makeAccount('a1', { authExpired: true });
    const warm = makeAccount('a2');
    setAccounts([expired, warm]);
    for (let i = 0; i < 3; i++) {
        assert.equal(selectAccountForSession({ accountId: null }), warm);
    }
});

test('selectAccountForSession: drops a sticky auth-expired account and resets the session', () => {
    const expired = makeAccount('a1', { authExpired: true });
    const warm = makeAccount('a2');
    setAccounts([expired, warm]);
    let resetCalled = 0;
    const session = { accountId: 'a1' };
    const picked = selectAccountForSession(session, { resetRemoteSession: () => { resetCalled++; } });
    assert.equal(picked, warm);
    assert.equal(resetCalled, 1);
    assert.equal(session.accountId, 'a2');
});

test('selectAccountForSession: throws 401 (not a cooling 429) when every account is auth-expired', () => {
    setAccounts([makeAccount('a1', { authExpired: true }), makeAccount('a2', { authExpired: true })]);
    assert.throws(() => selectAccountForSession({ accountId: null }), (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.type, 'auth_expired');
        return true;
    });
});

test('selectAccountForSession: throws 429 when every account is cooling down', () => {
    setAccounts([
        makeAccount('a1', { cooldownUntil: Date.now() + 60000 }),
        makeAccount('a2', { cooldownUntil: Date.now() + 30000 }),
    ]);
    assert.throws(() => selectAccountForSession({ accountId: null }), (err) => {
        assert.equal(err.status, 429);

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

test('markAccountAuthExpired: disables the account and clears any timed cooldown', () => {

    const a = makeAccount('a1', { cooldownUntil: Date.now() + 300000 });
    setAccounts([a]);
    markAccountAuthExpired(a);
    assert.equal(a.failures, 1);
    assert.equal(a.authExpired, true);
    assert.equal(a.cooldownUntil, 0, 'auth expiry must not be modelled as a cooldown');
});

test('markAccountAuthExpired: is a no-op for a missing account', () => {
    assert.doesNotThrow(() => markAccountAuthExpired(null));
    assert.doesNotThrow(() => markAccountAuthExpired(undefined));
});

test('setAccountToken: a refreshed token re-enables an auth-expired account', () => {
    const a = makeAccount('a1', { authExpired: true });
    setAccounts([a]);
    assert.equal(setAccountToken(a, 'fresh'), true);
    assert.equal(a.authExpired, false);
});

test('hasAvailableAccount: true only for ready accounts that are not cooling down', () => {
    setAccounts([makeAccount('a1', { cooldownUntil: Date.now() + 60000 })]);
    assert.equal(hasAvailableAccount(), false);
    setAccounts([makeAccount('a1'), makeAccount('a2', { cooldownUntil: Date.now() + 60000 })]);
    assert.equal(hasAvailableAccount(), true);
    setAccounts([makeAccount('a1', { token: '', cookie: '' })]);
    assert.equal(hasAvailableAccount(), false);
    setAccounts([makeAccount('a1', { authExpired: true })]);
    assert.equal(hasAvailableAccount(), false);
    setAccounts([]);
    assert.equal(hasAvailableAccount(), false);
});

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

test('resetAccountState: clears cooldowns, failures, auth expiry and lastUsedAt', () => {
    const a1 = makeAccount('a1', { failures: 3 });
    const a2 = makeAccount('a2', { failures: 1 });
    setAccounts([a1, a2]);

    assert.equal(selectAccountForSession({ accountId: null }).id, 'a1');
    assert.equal(selectAccountForSession({ accountId: null }).id, 'a2');

    a1.cooldownUntil = Date.now() + 60000;
    a2.cooldownUntil = Date.now() + 60000;
    a2.authExpired = true;
    resetAccountState();
    assert.equal(a1.cooldownUntil, 0);
    assert.equal(a2.cooldownUntil, 0);
    assert.equal(a1.failures, 0);
    assert.equal(a2.failures, 0);
    assert.equal(a2.authExpired, false);

    assert.equal(selectAccountForSession({ accountId: null }).id, 'a1');
});

test('getAccountById: finds by id and returns undefined for unknown ids', () => {
    const a1 = makeAccount('a1');
    setAccounts([a1]);
    assert.equal(getAccountById('a1'), a1);
    assert.equal(getAccountById('nope'), undefined);
});

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
    clock.advance(2000);
    await accounts.waitForCompletionSlot(a, { intervalMs: 5000, now: clock.now, sleep: clock.sleep });
    assert.deepEqual(clock.slept, [3000]);
    assert.equal(a.nextCompletionAt, clock.now() + 5000);
});

test('waitForCompletionSlot: pressure stretches the reservation interval', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();

    await accounts.waitForCompletionSlot(a, {
        intervalMs: 5000, pressure: 1, backoffFactor: 2, now: clock.now, sleep: clock.sleep,
    });
    assert.deepEqual(clock.slept, []);
    assert.equal(a.nextCompletionAt, clock.now() + 15000);
});

test('waitForCompletionSlot: pressure scales linearly and 0 preserves the base interval', async () => {
    const a = makeAccount('a1');
    const clock = fakeClock();

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

    const t = 1_000_000;
    const slept = [];
    const opts = { intervalMs: 5000, now: () => t, sleep: async (ms) => { slept.push(ms); } };
    await Promise.all([
        accounts.waitForCompletionSlot(a, opts),
        accounts.waitForCompletionSlot(a, opts),
        accounts.waitForCompletionSlot(a, opts),
    ]);

    assert.deepEqual(slept, [5000, 10000]);
});

test('waitForCompletionSlot: a long wait does not spend the whole deadline budget', async () => {
    const a = makeAccount('a1');
    a.nextCompletionAt = 0;
    const clock = fakeClock();
    await accounts.waitForCompletionSlot(a, { intervalMs: 5000, now: clock.now, sleep: clock.sleep });

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
