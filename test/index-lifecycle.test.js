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
