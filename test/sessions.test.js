'use strict';
// Tests for lib/sessions.js. The module is a singleton owning the mutable
// `sessions` Map and `uploadCache` Map, so each test resets both. No HTTP
// server or network is involved.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const sessions = require('../lib/sessions');
const uploadCache = require('../lib/upload-cache');

const {
    SESSION_TTL_MS,
    MAX_SESSION_ID_LENGTH,
    MAX_SESSIONS,
    getSessions,
    getSessionCount,
    createSession,
    resetRemoteSession,
    prepareSessionForPrompt,
    getOrCreateAgentSession,
    sweepIdleSessions,
} = sessions;

// Upload-cache state is owned by ./upload-cache now.
const UPLOAD_CACHE_TTL_MS = uploadCache.UPLOAD_CACHE_TTL_MS;
const getUploadCache = () => uploadCache.getCache();

// --- helpers ----------------------------------------------------------------

function resetState() {
    getSessions().clear();
    getUploadCache().clear();
}

// Silence the sweep log line during tests that trigger removals.
function quietly(fn) {
    const orig = console.log;
    console.log = () => {};
    try {
        return fn();
    } finally {
        console.log = orig;
    }
}

afterEach(resetState);

// --- createSession ----------------------------------------------------------

test('createSession: returns a fresh empty remote session', () => {
    const s = createSession();
    assert.equal(s.id, null);
    assert.equal(s.parentMessageId, null);
    assert.equal(s.createdAt, null);
    assert.equal(s.messageCount, 0);
    assert.equal(s.accountId, null);
    assert.ok(s.sentKeys instanceof Set);
    assert.equal(s.sentKeys.size, 0);
    assert.ok(typeof s.lastActivityAt === 'number' && s.lastActivityAt > 0);
});

test('createSession: returns an independent object each call', () => {
    const a = createSession();
    const b = createSession();
    assert.notEqual(a, b);
    assert.notEqual(a.sentKeys, b.sentKeys);
    a.sentKeys.add('x');
    assert.equal(b.sentKeys.size, 0);
});

// --- getOrCreateAgentSession ------------------------------------------------

test('getOrCreateAgentSession: creates and stores a session for a new agent', () => {
    const s = getOrCreateAgentSession('agent-1');
    assert.equal(getSessionCount(), 1);
    assert.equal(getSessions().get('agent-1'), s);
    assert.equal(s.messageCount, 0);
});

test('getOrCreateAgentSession: returns the same session on subsequent calls', () => {
    const a = getOrCreateAgentSession('agent-1');
    const b = getOrCreateAgentSession('agent-1');
    assert.equal(a, b);
    assert.equal(getSessionCount(), 1);
});

test('getOrCreateAgentSession: refreshes lastActivityAt on access', () => {
    const s = getOrCreateAgentSession('agent-1');
    s.lastActivityAt = 1;
    const again = getOrCreateAgentSession('agent-1');
    assert.equal(again, s);
    assert.ok(again.lastActivityAt > 1);
});

test('getOrCreateAgentSession: coerces non-string agent ids', () => {
    const s = getOrCreateAgentSession(42);
    assert.equal(getSessions().get('42'), s);
});

test('getOrCreateAgentSession: truncates ids longer than MAX_SESSION_ID_LENGTH', () => {
    const longId = 'x'.repeat(MAX_SESSION_ID_LENGTH + 50);
    getOrCreateAgentSession(longId);
    const expected = longId.slice(0, MAX_SESSION_ID_LENGTH);
    assert.ok(getSessions().has(expected));
    assert.equal(getSessionCount(), 1);
});

test('getOrCreateAgentSession: ids sharing the truncation prefix collide', () => {
    const base = 'y'.repeat(MAX_SESSION_ID_LENGTH);
    const a = getOrCreateAgentSession(base + 'AAA');
    const b = getOrCreateAgentSession(base + 'BBB');
    assert.equal(a, b);
    assert.equal(getSessionCount(), 1);
});

test('getOrCreateAgentSession: repairs a session whose sentKeys is not a Set', () => {
    const s = getOrCreateAgentSession('agent-1');
    s.sentKeys = null;
    const again = getOrCreateAgentSession('agent-1');
    assert.equal(again, s);
    assert.ok(again.sentKeys instanceof Set);
});

test('getOrCreateAgentSession: throws 503 too_many_sessions at capacity', () => {
    // Fill directly to avoid invoking the guard MAX_SESSIONS times.
    for (let i = 0; i < MAX_SESSIONS; i++) getSessions().set(`a${i}`, createSession());
    assert.equal(getSessionCount(), MAX_SESSIONS);
    assert.throws(
        () => getOrCreateAgentSession('overflow'),
        (err) => err.status === 503 && err.type === 'too_many_sessions' && /Too many active sessions/.test(err.message)
    );
    assert.equal(getSessionCount(), MAX_SESSIONS);
});

test('getOrCreateAgentSession: existing ids still resolve at capacity', () => {
    for (let i = 0; i < MAX_SESSIONS; i++) getSessions().set(`a${i}`, createSession());
    const s = getOrCreateAgentSession('a0');
    assert.equal(s, getSessions().get('a0'));
    assert.equal(getSessionCount(), MAX_SESSIONS);
});

// --- resetRemoteSession: remote delete hook --------------------------------

test('resetRemoteSession: invokes the injected deleter with accountId and remote id before clearing', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.accountId = 'acct-1';
    const seen = [];
    sessions.setRemoteSessionDeleter((accountId, sessionId) => seen.push([accountId, sessionId]));
    try {
        resetRemoteSession(s);
        assert.deepEqual(seen, [['acct-1', 'remote-1']]);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

test('resetRemoteSession: does not call the deleter when there is no remote id', () => {
    const s = createSession();
    let called = 0;
    sessions.setRemoteSessionDeleter(() => { called++; });
    try {
        resetRemoteSession(s);
        assert.equal(called, 0);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

test('resetRemoteSession: a throwing deleter does not break the local reset', () => {
    const s = createSession();
    s.id = 'remote-1';
    sessions.setRemoteSessionDeleter(() => { throw new Error('boom'); });
    try {
        const failed = resetRemoteSession(s);
        assert.equal(failed.failedSessionId, 'remote-1');
        assert.equal(s.id, null);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

// --- resetRemoteSession -----------------------------------------------------

test('resetRemoteSession: clears remote state and reports the failure snapshot', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.parentMessageId = 'pm-1';
    s.createdAt = 1000;
    s.messageCount = 7;
    s.accountId = 'acct-1';
    s.sentKeys.add('k1');

    const failed = resetRemoteSession(s);

    assert.deepEqual(failed, { failedSessionId: 'remote-1', failedMessageCount: 7, accountId: 'acct-1' });
    assert.equal(s.id, null);
    assert.equal(s.parentMessageId, null);
    assert.equal(s.createdAt, null);
    assert.equal(s.messageCount, 0);
    assert.equal(s.sentKeys.size, 0);
    // accountId is sticky by default.
    assert.equal(s.accountId, 'acct-1');
});

test('resetRemoteSession: releaseAccount clears the sticky account', () => {
    const s = createSession();
    s.accountId = 'acct-1';
    const failed = resetRemoteSession(s, { releaseAccount: true });
    assert.equal(s.accountId, null);
    assert.equal(failed.accountId, 'acct-1');
});

test('resetRemoteSession: replaces sentKeys with a new Set instance', () => {
    const s = createSession();
    const before = s.sentKeys;
    before.add('k');
    resetRemoteSession(s);
    assert.notEqual(s.sentKeys, before);
    assert.equal(s.sentKeys.size, 0);
});

// --- prepareSessionForPrompt ------------------------------------------------

test('prepareSessionForPrompt: returns null when there is no session', () => {
    assert.equal(prepareSessionForPrompt(null), null);
});

test('prepareSessionForPrompt: returns null when the session has no remote id', () => {
    assert.equal(prepareSessionForPrompt(createSession()), null);
});

test('prepareSessionForPrompt: returns null for a healthy active session', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = Date.now();
    s.messageCount = 1;
    assert.equal(prepareSessionForPrompt(s), null);
});

test('prepareSessionForPrompt: resets on session_ttl', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = 1000;
    s.messageCount = 1;

    const out = prepareSessionForPrompt(s, 1000 + SESSION_TTL_MS + 1);
    assert.equal(out.reason, 'session_ttl');
    assert.equal(s.id, null);
});

test('prepareSessionForPrompt: TTL boundary is exclusive (not expired at exactly TTL)', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = 1000;
    s.messageCount = 1;
    assert.equal(prepareSessionForPrompt(s, 1000 + SESSION_TTL_MS), null);
    assert.equal(s.id, 'remote-1');
});

test('prepareSessionForPrompt: clears the malformed-reset counter on rollover', () => {
    // The counter is scoped to one remote session; a TTL rollover starts
    // a fresh conversation and must not carry strikes over to it, otherwise the
    // account would be rotated prematurely.
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = 1000;
    s.messageCount = 1;
    s.malformedResets = 2;

    prepareSessionForPrompt(s, 1000 + SESSION_TTL_MS + 1);
    assert.equal(s.malformedResets, 0);
});

test('prepareSessionForPrompt: ignores missing createdAt for TTL check', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = null;
    s.messageCount = 1;
    assert.equal(prepareSessionForPrompt(s, Date.now() + SESSION_TTL_MS * 10), null);
});

// --- resetAllRemoteSessions -------------------------------------------------

test('resetAllRemoteSessions: deletes the remote id of every session and clears local state', () => {
    const a = getOrCreateAgentSession('a');
    a.id = 'r-a'; a.accountId = 'acct-1';
    const b = getOrCreateAgentSession('b');
    b.id = 'r-b'; b.accountId = 'acct-2';
    const seen = [];
    sessions.setRemoteSessionDeleter((accountId, sessionId) => seen.push([accountId, sessionId]));
    try {
        const attempted = sessions.resetAllRemoteSessions();
        assert.equal(attempted, 2);
        assert.deepEqual(seen.sort(), [['acct-1', 'r-a'], ['acct-2', 'r-b']]);
        assert.equal(a.id, null);
        assert.equal(b.id, null);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

test('resetAllRemoteSessions: skips sessions without a remote id', () => {
    getOrCreateAgentSession('idle');
    let called = 0;
    sessions.setRemoteSessionDeleter(() => { called++; });
    try {
        assert.equal(sessions.resetAllRemoteSessions(), 0);
        assert.equal(called, 0);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

// --- sweepIdleSessions ------------------------------------------------------

test('sweepIdleSessions: deletes the upstream session before dropping an idle one', () => {
    // Regression: a sweep used to call sessions.delete() directly, leaking the
    // remote session on the account. It must route through resetRemoteSession().
    const s = getOrCreateAgentSession('idle');
    s.id = 'remote-9';
    s.accountId = 'acct-9';
    s.lastActivityAt = Date.now() - 10_000;
    const seen = [];
    sessions.setRemoteSessionDeleter((accountId, sessionId) => seen.push([accountId, sessionId]));
    try {
        const removed = quietly(() => sweepIdleSessions(5000));
        assert.equal(removed, 1);
        assert.equal(getSessionCount(), 0);
        assert.deepEqual(seen, [['acct-9', 'remote-9']]);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

test('sweepIdleSessions: no deleter call for an idle session without a remote id', () => {
    const s = getOrCreateAgentSession('idle');
    s.lastActivityAt = Date.now() - 10_000;
    let called = 0;
    sessions.setRemoteSessionDeleter(() => { called++; });
    try {
        quietly(() => sweepIdleSessions(5000));
        assert.equal(getSessionCount(), 0);
        assert.equal(called, 0);
    } finally { sessions.setRemoteSessionDeleter(null); }
});

test('sweepIdleSessions: removes sessions idle beyond maxIdleMs and reports the count', () => {
    const now = Date.now();
    const old = getOrCreateAgentSession('old');
    old.lastActivityAt = now - 10_000;
    const fresh = getOrCreateAgentSession('fresh');
    fresh.lastActivityAt = now;

    const removed = quietly(() => sweepIdleSessions(5000));
    assert.equal(removed, 1);
    assert.ok(!getSessions().has('old'));
    assert.ok(getSessions().has('fresh'));
});

test('sweepIdleSessions: keeps sessions idle exactly at the threshold', () => {
    // Pin Date.now so the exact-boundary comparison (age === maxIdleMs) is
    // deterministic. Without this, the real clock can advance between setting
    // `lastActivityAt` and `sweepIdleSessions` reading its own `Date.now()`,
    // making the age 5001 > 5000 and flaking on slow/instrumented runs.
    const realNow = Date.now;
    Date.now = () => 1_000_000;
    try {
        const s = getOrCreateAgentSession('edge');
        s.lastActivityAt = Date.now() - 5000;
        const removed = sweepIdleSessions(5000);
        assert.equal(removed, 0);
        assert.ok(getSessions().has('edge'));
    } finally {
        Date.now = realNow;
    }
});

test('sweepIdleSessions: treats missing lastActivityAt as very old', () => {
    getSessions().set('no-ts', createSession());
    getSessions().get('no-ts').lastActivityAt = 0;
    const removed = quietly(() => sweepIdleSessions(1));
    assert.equal(removed, 1);
    assert.equal(getSessionCount(), 0);
});

test('sweepIdleSessions: purges stale upload-cache entries but keeps fresh ones', () => {
    const now = Date.now();
    const cache = getUploadCache();
    cache.set('stale', { id: 'u1', filename: 'a.png', cachedAt: now - UPLOAD_CACHE_TTL_MS - 1 });
    cache.set('fresh', { id: 'u2', filename: 'b.png', cachedAt: now });

    quietly(() => sweepIdleSessions(SESSION_TTL_MS * 2));
    assert.ok(!cache.has('stale'));
    assert.ok(cache.has('fresh'));
});

test('sweepIdleSessions: drops malformed upload-cache entries', () => {
    const cache = getUploadCache();
    cache.set('nil', null);
    quietly(() => sweepIdleSessions(SESSION_TTL_MS * 2));
    assert.ok(!cache.has('nil'));
});

test('sweepIdleSessions: returns 0 and mutates nothing when all state is fresh', () => {
    const s = getOrCreateAgentSession('agent');
    s.lastActivityAt = Date.now();
    getUploadCache().set('k', { id: 'u', filename: 'f', cachedAt: Date.now() });
    const removed = sweepIdleSessions();
    assert.equal(removed, 0);
    assert.equal(getSessionCount(), 1);
    assert.equal(getUploadCache().size, 1);
});

test('sweepIdleSessions: empty registries are a no-op', () => {
    assert.equal(sweepIdleSessions(), 0);
    assert.equal(getSessionCount(), 0);
    assert.equal(getUploadCache().size, 0);
});

// --- exported constants -----------------------------------------------------

test('exported constants are positive and consistent with defaults', () => {
    assert.ok(Number.isFinite(SESSION_TTL_MS) && SESSION_TTL_MS > 0);
    assert.ok(Number.isInteger(MAX_SESSION_ID_LENGTH) && MAX_SESSION_ID_LENGTH > 0);
    assert.ok(Number.isInteger(MAX_SESSIONS) && MAX_SESSIONS > 0);
    // The upload cache and its TTL now live in ./upload-cache.
    assert.ok(Number.isFinite(UPLOAD_CACHE_TTL_MS) && UPLOAD_CACHE_TTL_MS > 0);
    assert.equal(typeof uploadCache.sweep, 'function');
});
