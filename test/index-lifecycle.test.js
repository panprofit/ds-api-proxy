'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const upstream = require('../lib/upstream');
const accounts = require('../lib/accounts');
const config = require('../lib/config');
const sessions = require('../lib/sessions');

const calls = [];
let behaviour = async () => true;
upstream.deleteRemoteSession = async (account, headers, sessionId) => {
    calls.push({ accountId: account && account.id, sessionId, hasHeaders: Boolean(headers) });
    return behaviour(account, headers, sessionId);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-index-'));
fs.writeFileSync(path.join(tmp, 'a.json'), JSON.stringify({ token: 't', cookie: 'c' }));
config.reload({ DS_AUTH_DIR: tmp });
accounts.loadDSConfig({ fatal: false });
const account = accounts.getAccounts()[0];

require('../index');

function makeSessionWithRemote(accountId) {
    const agentId = 'agent-' + Math.random().toString(36).slice(2);
    const session = sessions.getOrCreateAgentSession(agentId);
    session.id = 'remote-session-1';
    session.accountId = accountId;
    return session;
}

const settle = () => new Promise(r => setTimeout(r, 50));

test('index.js: resetting a remote session deletes it upstream for the owning account', async () => {
    calls.length = 0;
    behaviour = async () => true;
    const session = makeSessionWithRemote(account.id);
    sessions.resetRemoteSession(session);
    await settle();
    assert.equal(calls.length, 1, 'upstream delete must be called once');
    assert.equal(calls[0].accountId, account.id);
    assert.equal(calls[0].sessionId, 'remote-session-1');
    assert.equal(calls[0].hasHeaders, true, 'the account header set must be forwarded');
});

test('index.js: no account for the id -> skip the upstream delete without throwing', async () => {
    calls.length = 0;
    const session = makeSessionWithRemote('no-such-account');
    assert.doesNotThrow(() => sessions.resetRemoteSession(session));
    await settle();
    assert.equal(calls.length, 0, 'nothing to delete without an account');
});

test('index.js: a failed delete is swallowed (no unhandled rejection escapes)', async () => {
    calls.length = 0;
    behaviour = async () => { throw new Error('boom'); };
    const escaped = [];
    const onUnhandled = (e) => escaped.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
        const session = makeSessionWithRemote(account.id);
        assert.doesNotThrow(() => sessions.resetRemoteSession(session));
        await settle();
        assert.equal(calls.length, 1);
        assert.deepEqual(escaped, [], 'the best-effort delete must not leak a rejection');
    } finally {
        process.off('unhandledRejection', onUnhandled);
        behaviour = async () => true;
    }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('index.js: deleteOrphanedRemoteSessions deletes every journaled session upstream', async () => {
    const journal = path.join(tmp, 'journal-2.json');
    config.reload({ DS_AUTH_DIR: tmp, DS_SESSION_JOURNAL: journal });
    accounts.loadDSConfig({ fatal: false });
    calls.length = 0;
    behaviour = async () => true;

    sessions.takeOrphanedRemoteSessions();
    sessions.noteRemoteSession(account.id, 'orphan-a');
    sessions.noteRemoteSession(account.id, 'orphan-b');

    const index = require('../index');
    assert.equal(index.deleteOrphanedRemoteSessions(), 2);
    await settle();

    assert.deepEqual(calls.map(c => c.sessionId).sort(), ['orphan-a', 'orphan-b']);
    assert.equal(sessions.takeOrphanedRemoteSessions().length, 0, 'the journal must be drained');

    config.reload({ DS_AUTH_DIR: tmp });
    fs.rmSync(journal, { force: true });
});

test('index.js: buildRuntime wires a sweep interval and a listen callback', async () => {
    const index = require('../index');
    const runtime = index.buildRuntime({ startedAt: 1 });
    assert.equal(typeof runtime.listen, 'function');
    assert.equal(typeof runtime.semaphore.waitForZero, 'function');
    assert.equal(runtime.requestDeps.requestDeadlineMs > 0, true);
    if (runtime.shutdownCtl && typeof runtime.shutdownCtl.shutdown === 'function') {
        assert.equal(runtime.shutdownCtl.shuttingDown, false);
    }
    if (runtime.server && typeof runtime.server.close === 'function') runtime.server.close();
});

test('index.js: a journaled orphan is deleted and forgotten on success', async () => {
    const journal = path.join(tmp, 'journal-3.json');
    config.reload({ DS_AUTH_DIR: tmp, DS_SESSION_JOURNAL: journal });
    accounts.loadDSConfig({ fatal: false });
    calls.length = 0;
    behaviour = async () => true;

    sessions.takeOrphanedRemoteSessions();
    sessions.noteRemoteSession(account.id, 'orphan-c');
    const index = require('../index');
    assert.equal(index.deleteOrphanedRemoteSessions(), 1);
    await settle();
    assert.equal(calls.length, 1);

    sessions.takeOrphanedRemoteSessions();
    sessions.noteRemoteSession(account.id, 'orphan-d');
    assert.equal(sessions.takeOrphanedRemoteSessions().length, 1);

    config.reload({ DS_AUTH_DIR: tmp });
    fs.rmSync(journal, { force: true });
});
