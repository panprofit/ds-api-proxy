'use strict';
// Detecting a rewritten conversation: when the client's `messages` array gets
// shorter (a /compact summary replaces the previous turns), the remote DS
// session must be dropped so it does not keep the pre-compaction context.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const handlers = require('../lib/handlers');
const sessions = require('../lib/sessions');
const accounts = require('../lib/accounts');

// These tests exercise the session-preserving branches, so they must send a
// session id: an anonymous request (no headers) is ephemeral and the pipeline
// would delete the session before the assertions run.
function fakeReq() {
    return { headers: { 'x-session-id': 'dev-agent' }, socket: { remoteAddress: '127.0.0.1' }, on: () => {} };
}

function fakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res.statusCode = null;
    res.chunks = [];
    res.ended = false;
    res.writeHead = (status, hdrs) => { res.statusCode = status; res.headers = hdrs || {}; res.headersSent = true; };
    res.flushHeaders = () => {};
    res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
    res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(String(chunk)); res.ended = true; };
    res.body = () => res.chunks.join('');
    return res;
}

function makeAccount(id) {
    return { id, file: '/tmp/' + id + '.json', config: { token: 't', cookie: 'c' }, headers: {}, cooldownUntil: 0, failures: 0, lastUsedAt: 0 };
}

async function withAccounts(list, fn) {
    const arr = accounts.getAccounts();
    const saved = arr.slice();
    arr.length = 0;
    arr.push(...list);
    for (const k of [...sessions.getSessions().keys()]) sessions.getSessions().delete(k);
    try { return await fn(); }
    finally {
        arr.length = 0;
        arr.push(...saved);
        for (const k of [...sessions.getSessions().keys()]) sessions.getSessions().delete(k);
    }
}

function withDeps() {
    return {
        askDSStream: async (args) => ({ resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false }),
        readDSResponse: async () => ({ content: 'hello', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        resolveMessageAttachments: async () => ({ fileIds: [], uploads: [], failures: [] }),
        malformedCooldownMs: 0,
        requestDeadlineMs: 5000,
    };
}

function body(messages) { return JSON.stringify({ messages }); }

test('history shrink: a shorter messages array resets the remote session', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const session = sessions.getOrCreateAgentSession('dev-agent');
        session.id = 'remote-1';
        session.lastMessagesLength = 10;
        const res = fakeRes();
        await handlers.handleChatCompletions(fakeReq(), res, body([{ role: 'user', content: 'hi' }]), withDeps());
        assert.equal(res.statusCode, 200);
        assert.equal(session.id, null, 'the remote session should have been reset after the shrink');
        assert.equal(session.lastMessagesLength, 1, 'the new length is recorded for the next request');
    });
});

test('history shrink: a growing messages array keeps the remote session', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const session = sessions.getOrCreateAgentSession('dev-agent');
        session.id = 'remote-1';
        session.lastMessagesLength = 2;
        const res = fakeRes();
        await handlers.handleChatCompletions(fakeReq(), res, body([
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
        ]), withDeps());
        assert.equal(res.statusCode, 200);
        assert.equal(session.id, 'remote-1', 'a longer history must reuse the remote session');
        assert.equal(session.lastMessagesLength, 3);
    });
});

test('history shrink: the first request records the length without resetting', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const session = sessions.getOrCreateAgentSession('dev-agent');
        session.id = 'remote-1';
        const res = fakeRes();
        await handlers.handleChatCompletions(fakeReq(), res, body([{ role: 'user', content: 'hi' }]), withDeps());
        assert.equal(res.statusCode, 200);
        assert.equal(session.id, 'remote-1', 'the first request must not reset the session');
        assert.equal(session.lastMessagesLength, 1);
    });
});
