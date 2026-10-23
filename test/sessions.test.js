'use strict';

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
    deleteSession,
    resetRemoteSession,
    prepareSessionForPrompt,
    getOrCreateAgentSession,
    sweepIdleSessions,
} = sessions;

const UPLOAD_CACHE_TTL_MS = uploadCache.UPLOAD_CACHE_TTL_MS;
const getUploadCache = () => uploadCache.getCache();

function resetState() {
    getSessions().clear();
    getUploadCache().clear();
}

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

test('getOrCreateAgentSession: does NOT touch lastActivityAt on access', () => {

    const s = getOrCreateAgentSession('agent-1');
    s.lastActivityAt = 1;
    const again = getOrCreateAgentSession('agent-1');
    assert.equal(again, s);
    assert.equal(again.lastActivityAt, 1);
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

test('deleteSession: deletes a long id under its truncated key, not the raw one', () => {
    const longId = 'z'.repeat(MAX_SESSION_ID_LENGTH + 20);
    const created = getOrCreateAgentSession(longId);
    assert.equal(getSessionCount(), 1);

    assert.equal(deleteSession(longId), true);
    assert.equal(getSessionCount(), 0);
    assert.notEqual(getOrCreateAgentSession(longId), created);
});

test('getOrCreateAgentSession: repairs a session whose sentKeys is not a Set', () => {
    const s = getOrCreateAgentSession('agent-1');
    s.sentKeys = null;
    const again = getOrCreateAgentSession('agent-1');
    assert.equal(again, s);
    assert.ok(again.sentKeys instanceof Set);
});

test('getOrCreateAgentSession: throws 503 too_many_sessions at capacity', () => {

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

test('prepareSessionForPrompt: returns null when there is no session', () => {
    assert.equal(prepareSessionForPrompt(null), null);
});

test('prepareSessionForPrompt: returns null when the session has no remote id', () => {
    assert.equal(prepareSessionForPrompt(createSession()), null);
});

test('prepareSessionForPrompt: returns null for a healthy active session', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.lastActivityAt = Date.now();
    s.messageCount = 1;
    assert.equal(prepareSessionForPrompt(s), null);
});

test('prepareSessionForPrompt: does NOT reset a session that keeps talking past the TTL', () => {

    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = 1000;
    s.lastActivityAt = 1000 + SESSION_TTL_MS * 5;
    s.messageCount = 42;
    assert.equal(prepareSessionForPrompt(s, s.lastActivityAt + SESSION_TTL_MS), null);
    assert.equal(s.id, 'remote-1');
});

test('prepareSessionForPrompt: resets on session_ttl after the idle window', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.lastActivityAt = 1000;
    s.messageCount = 1;

    const out = prepareSessionForPrompt(s, 1000 + SESSION_TTL_MS + 1);
    assert.equal(out.reason, 'session_ttl');
    assert.equal(s.id, null);
});

test('prepareSessionForPrompt: idle TTL boundary is exclusive (not expired at exactly TTL)', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.lastActivityAt = 1000;
    s.messageCount = 1;
    assert.equal(prepareSessionForPrompt(s, 1000 + SESSION_TTL_MS), null);
    assert.equal(s.id, 'remote-1');
});

test('prepareSessionForPrompt: falls back to createdAt when lastActivityAt is missing', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = 1000;
    s.lastActivityAt = undefined;
    s.messageCount = 1;
    const out = prepareSessionForPrompt(s, 1000 + SESSION_TTL_MS + 1);
    assert.equal(out.reason, 'session_ttl');
    assert.equal(s.id, null);
});

test('prepareSessionForPrompt: ignores missing createdAt/lastActivityAt for TTL check', () => {
    const s = createSession();
    s.id = 'remote-1';
    s.createdAt = null;
    s.lastActivityAt = null;
    s.messageCount = 1;
    assert.equal(prepareSessionForPrompt(s, Date.now() + SESSION_TTL_MS * 10), null);
});

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

test('sweepIdleSessions: ephemeral sessions use the short backstop age', () => {

    const s = getOrCreateAgentSession('anon-test');
    s.ephemeral = true;
    s.lastActivityAt = Date.now() - 11 * 60 * 1000;
    const removed = quietly(() => sweepIdleSessions(SESSION_TTL_MS * 2));
    assert.equal(removed, 1);
    assert.equal(getSessionCount(), 0);
});

test('sweepIdleSessions: a fresh ephemeral session is kept', () => {
    const s = getOrCreateAgentSession('anon-fresh');
    s.ephemeral = true;
    s.lastActivityAt = Date.now();
    const removed = quietly(() => sweepIdleSessions(SESSION_TTL_MS * 2));
    assert.equal(removed, 0);
    assert.equal(getSessionCount(), 1);
});

test('sweepIdleSessions: deletes the upstream session before dropping an idle one', () => {

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

test('exported constants are positive and consistent with defaults', () => {
    assert.ok(Number.isFinite(SESSION_TTL_MS) && SESSION_TTL_MS > 0);
    assert.ok(Number.isInteger(MAX_SESSION_ID_LENGTH) && MAX_SESSION_ID_LENGTH > 0);
    assert.ok(Number.isInteger(MAX_SESSIONS) && MAX_SESSIONS > 0);

    assert.ok(Number.isFinite(UPLOAD_CACHE_TTL_MS) && UPLOAD_CACHE_TTL_MS > 0);
    assert.equal(typeof uploadCache.sweep, 'function');
});

test('session journal: note and forget keep the file in sync', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}.json`);
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        sessions.noteRemoteSession('acct-1', 'sess-1');
        sessions.noteRemoteSession('acct-2', 'sess-2');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [
            { id: 'sess-1', accountId: 'acct-1' },
            { id: 'sess-2', accountId: 'acct-2' },
        ]);
        sessions.forgetRemoteSession('sess-1');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'sess-2', accountId: 'acct-2' }]);
    } finally {
        config.reload();
        fs.rmSync(file, { force: true });
    }
});

test('session journal: takeOrphanedRemoteSessions drains the journal', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}-b.json`);
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        sessions.noteRemoteSession('acct-1', 'orphan-1');
        const orphans = sessions.takeOrphanedRemoteSessions();
        assert.deepEqual(orphans, [{ id: 'orphan-1', accountId: 'acct-1' }]);
        assert.equal(fs.existsSync(file), false);
        assert.deepEqual(sessions.takeOrphanedRemoteSessions(), []);
    } finally {
        config.reload();
        fs.rmSync(file, { force: true });
    }
});

test('session journal: an existing journal file is loaded on first use', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}-c.json`);
    fs.writeFileSync(file, JSON.stringify([
        { id: 'pre-1', accountId: 'acct-9' },
        { id: '', accountId: 'acct-x' },
        { accountId: 'acct-y' },
        { id: 'pre-2' },
    ]));
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        assert.deepEqual(sessions.takeOrphanedRemoteSessions(), [
            { id: 'pre-1', accountId: 'acct-9' },
            { id: 'pre-2', accountId: null },
        ]);
    } finally {
        config.reload();
        fs.rmSync(file, { force: true });
    }
});

test('session journal: a corrupt journal file is ignored', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}-d.json`);
    fs.writeFileSync(file, 'not json at all');
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        assert.deepEqual(sessions.takeOrphanedRemoteSessions(), []);
    } finally {
        config.reload();
        fs.rmSync(file, { force: true });
    }
});

test('session journal: a non-array journal is ignored', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}-e.json`);
    fs.writeFileSync(file, JSON.stringify({ ids: ['a'] }));
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        assert.deepEqual(sessions.takeOrphanedRemoteSessions(), []);
    } finally {
        config.reload();
        fs.rmSync(file, { force: true });
    }
});

test('session journal: a missing journal file yields no orphans', () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}-f.json`);
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        assert.deepEqual(sessions.takeOrphanedRemoteSessions(), []);
    } finally {
        config.reload();
    }
});

test('noteRemoteSession: an empty session id is not journaled', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const config = require('../lib/config');
    const file = nodePath.join(os.tmpdir(), `ds-journal-${process.pid}-${Date.now()}-g.json`);
    config.reload({ DS_SESSION_JOURNAL: file });
    try {
        sessions.noteRemoteSession('acct-1', '');
        assert.equal(fs.existsSync(file), false);
        sessions.noteRemoteSession('acct-1', null);
        assert.equal(fs.existsSync(file), false);
        sessions.forgetRemoteSession(null);
        assert.equal(fs.existsSync(file), false);
    } finally {
        config.reload();
        fs.rmSync(file, { force: true });
    }
});
