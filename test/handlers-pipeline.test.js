'use strict';
// Integration tests for the shared runCompletionPipeline via the two public
// handlers. The HTTP layer is faked (a minimal req/res) and every upstream /
// account dependency is injected, so no network, auth or real socket is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const handlers = require('../lib/handlers');
const sessions = require('../lib/sessions');
const accounts = require('../lib/accounts');

// --- fakes ------------------------------------------------------------------

function fakeReq({ headers = {}, remoteAddress = '127.0.0.1' } = {}) {
    return { headers, socket: { remoteAddress }, on: () => {} };
}

function fakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res.statusCode = null;
    res.headers = null;
    res.chunks = [];
    res.ended = false;
    res.writeHead = (status, hdrs) => { res.statusCode = status; res.headers = hdrs || {}; res.headersSent = true; };
    res.flushHeaders = () => {};
    res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
    res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(String(chunk)); res.ended = true; };
    res.body = () => res.chunks.join('');
    res.json = () => JSON.parse(res.body());
    return res;
}

function makeAccount(id) {
    return {
        id,
        file: `/tmp/${id}.json`,
        config: { token: 't', cookie: 'c' },
        headers: {},
        cooldownUntil: 0,
        failures: 0,
        lastUsedAt: 0,
    };
}

// Install `list` as the live accounts array for the duration of `fn`, and
// clear sessions so each test starts from a clean remote-session state.
async function withAccounts(list, fn) {
    const arr = accounts.getAccounts();
    const saved = arr.slice();
    arr.length = 0;
    arr.push(...list);
    for (const k of [...sessions.getSessions().keys()]) sessions.getSessions().delete(k);
    try {
        return await fn();
    } finally {
        arr.length = 0;
        arr.push(...saved);
        for (const k of [...sessions.getSessions().keys()]) sessions.getSessions().delete(k);
    }
}

function depsOk({ results = [{ content: 'hello', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }] } = {}) {
    let i = 0;
    return {
        askDSStream: async (args) => ({ resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false }),
        readDSResponse: async () => results[Math.min(i++, results.length - 1)],
        requestDeadlineMs: 5000,
    };
}

function withDeps(overrides = {}) {
    return { ...depsOk(), resolveMessageAttachments: async () => ({ fileIds: [], uploads: [], failures: [] }), ...overrides };
}

// --- chat completions: success paths ---------------------------------------

test('handleChatCompletions: non-stream success writes JSON', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
        }), withDeps());
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /application\/json/);
        const json = res.json();
        assert.equal(json.object, 'chat.completion');
        assert.equal(json.choices[0].message.content, 'hello');
    });
});

test('handleChatCompletions: echoes the requested model in the response', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            model: 'my-model',
            messages: [{ role: 'user', content: 'hi' }],
        }), withDeps());
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().model, 'my-model');
    });
});

test('handleChatCompletions: stream success writes SSE chunks', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        }), withDeps());
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /text\/event-stream/);
        assert.match(res.body(), /data: /);
        assert.match(res.body(), /\[DONE\]/);
    });
});

test('handleChatCompletions: tool-call result is serialized as tool_calls', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            readDSResponse: async () => ({ content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'read a file' }],
            tools: [{ type: 'function', function: { name: 'read' } }],
        }), deps);
        assert.equal(res.statusCode, 200);
        const json = res.json();
        assert.ok(Array.isArray(json.choices[0].message.tool_calls));
    });
});

// --- chat completions: failure paths ---------------------------------------

test('handleChatCompletions: invalid params are 400 before any upstream call', async () => {
    const req = fakeReq();
    const res = fakeRes();
    let called = false;
    await handlers.handleChatCompletions(req, res, '[]', withDeps({
        askDSStream: async () => { called = true; },
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
    assert.equal(res.json().error.type, 'invalid_request_error');
});

test('handleChatCompletions: no available account is rejected as 429 before recovery', async () => {
    // Every account is cooling down at selection time, so the pipeline fails
    // fast with a 429 rather than starting an upstream request.
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const cooling = makeAccount('a1');
        cooling.cooldownUntil = Date.now() + 60000;
        const arr = accounts.getAccounts();
        arr.length = 0;
        arr.push(cooling);
        const deps = withDeps({
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), deps);
        assert.equal(res.statusCode, 429);
        assert.equal(res.json().error.type, 'rate_limit_error');
    });
});

test('handleChatCompletions: a terminal recovery failure (non-stream) is written as JSON', async () => {
    // A healthy account at selection time, but the upstream always returns
    // unclosed tool markup. Recovery rotates immediately (no same-account
    // retry, no cooldown) and fails terminally on the exhausted account budget;
    // because nothing was committed yet (no streaming), the error must be a
    // JSON body with the recovery status.
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            readDSResponse: async () => ({
                content: '<tool_call>{"name":"read","arguments":{"path":',
                reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null,
            }),
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'read' } }],
        }), deps);
        assert.equal(res.statusCode, 502);
        assert.equal(res.headers['Content-Type'], 'application/json');
        // Single-account budget: the terminal body comes from the shared
        // exhausted-accounts block, whose type falls back to 'empty_response'.
        assert.equal(res.json().error.type, 'empty_response');
    });
});

test('handleChatCompletions: recovery failure after SSE commit writes an error frame', async () => {
    // The account is healthy at request time, so the pipeline commits to SSE
    // before the upstream wait. The response is then malformed markup, which
    // cools the sole account and makes recovery fail — after the commit — so
    // the failure must arrive as an in-band SSE error frame, not an HTTP 429.
    const acct = makeAccount('a1');
    await withAccounts([acct], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            // Always broken markup for a known tool: strict retry keeps failing,
            // the sole account gets cooled during recovery, and the run ends
            // with a terminal 429 after the SSE headers were already committed.
            readDSResponse: async () => ({
                content: '<tool_call>{"name":"read","arguments":{"path":',
                reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null,
            }),
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            tools: [{ type: 'function', function: { name: 'read' } }],
        }), deps);
        assert.equal(res.statusCode, 200);
        assert.match(res.body(), /event: error/);
        assert.match(res.body(), /\[DONE\]/);
    });
});

test('handleChatCompletions: a thrown error is caught and reported as JSON', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            resolveMessageAttachments: async () => { throw Object.assign(new Error('boom'), { status: 502, type: 'upstream_error' }); },
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), deps);
        assert.equal(res.statusCode, 502);
        assert.equal(res.json().error.type, 'upstream_error');
    });
});

// --- responses endpoint ------------------------------------------------------

test('handleResponses: non-stream success writes a responses payload', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        await handlers.handleResponses(req, res, JSON.stringify({
            input: [{ role: 'user', content: 'hi' }],
        }), withDeps());
        assert.equal(res.statusCode, 200);
        const json = res.json();
        assert.equal(json.object, 'response');
        assert.ok(Array.isArray(json.output));
    });
});

test('handleResponses: stream success writes SSE events', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        await handlers.handleResponses(req, res, JSON.stringify({
            input: [{ role: 'user', content: 'hi' }],
            stream: true,
        }), withDeps());
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /text\/event-stream/);
        assert.match(res.body(), /event: response\./);
    });
});

test('handleResponses: invalid params are 400', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await handlers.handleResponses(req, res, '[]', withDeps());
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.type, 'invalid_request_error');
});

// --- pipeline edge branches -------------------------------------------------

test('handleChatCompletions: a prompt rollover resets the session before the prompt is built', async () => {
    // Pre-seed an existing remote session past its TTL so the pipeline's
    // prepareSessionForPrompt() fires and logs the rollover before building the
    // prompt. (Rollover is TTL-only now; message depth no longer triggers it.)
    await withAccounts([makeAccount('a1')], async () => {
        const session = sessions.getOrCreateAgentSession('dev-agent');
        session.id = 'remote-1';
        session.messageCount = 100;
        // Idle longer than DS_SESSION_TTL_MS (default 2h) => rolled over.
        session.createdAt = Date.now() - 3 * 60 * 60 * 1000;
        session.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000;
        // A session id keeps the request non-ephemeral, so the rolled-over
        // session is not deleted by the anonymous-cleanup in finally.
        const req = fakeReq({ headers: { 'x-session-id': 'dev-agent' } });
        const res = fakeRes();
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), withDeps());
        assert.equal(res.statusCode, 200);
        assert.equal(session.id, null, 'the rolled-over session should have been reset');
    });
});

test('handleChatCompletions: clientGone during recovery returns without writing', async () => {
    // The upstream wait emits `close` on res, so clientGone becomes true while
    // recovery is in flight; the pipeline must then return silently.
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            readDSResponse: async () => {
                res.emit('close');
                return { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null };
            },
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), deps);
        assert.equal(res.statusCode, null, 'nothing should be written once the client is gone');
        assert.equal(res.ended, false);
    });
});

// --- attachment / diagnostics branches --------------------------------------

test('handleChatCompletions: uploads are reported and forwarded to recovery', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const calls = [];
        const deps = withDeps({
            resolveMessageAttachments: async () => ({
                fileIds: ['f1'],
                uploads: [{ id: 'f1', filename: 'a.png' }],
                failures: [],
            }),
            askDSStream: async (args) => { calls.push(args); return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false }; },
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
        }), deps);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(calls[0].fileIds, ['f1']);
    });
});

test('handleChatCompletions: an account change re-uploads the full attachment history', async () => {
    await withAccounts([makeAccount('a1'), makeAccount('a2')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const resolveCalls = [];
        let captured = null;
        const deps = withDeps({
            resolveMessageAttachments: async (msgs, account) => {
                resolveCalls.push({ count: msgs.length, accountId: account.id });
                return { fileIds: resolveCalls.length === 1 ? ['f1'] : ['f2'], uploads: [], failures: [] };
            },
            askDSStream: async (args) => {
                captured = args;
                return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false };
            },
        });
        const messages = [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
            { role: 'assistant', content: 'seen' },
            { role: 'user', content: 'follow-up' },
        ];
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages }), deps);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(captured.fileIds, ['f1']);
        assert.equal(captured.fileIdsAccountId, 'a1');
        assert.equal(typeof captured.resolveFileIds, 'function');
        assert.deepEqual(await captured.resolveFileIds(makeAccount('a2'), {}), ['f2']);
        assert.deepEqual(resolveCalls, [
            { count: 3, accountId: 'a1' },
            { count: 3, accountId: 'a2' },
        ]);
    });
});

test('handleChatCompletions: attachment failures are logged but do not fail the request', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            resolveMessageAttachments: async () => ({
                fileIds: [],
                uploads: [],
                failures: [{ url: 'https://x/a.png', error: 'boom' }],
            }),
        });
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), deps);
        assert.equal(res.statusCode, 200);
    });
});

// --- responses: post-commit error frame ------------------------------------

test('handleResponses: a post-commit context overflow emits response.failed for compaction', async () => {
    // Pi's agent only recognises an overflow when it arrives as a
    // `response.failed` event with response.error.code set. The DS upstream
    // reports "context too long" as an in-band model error; recovery maps it to
    // a terminal 400. Because SSE headers are already committed, that failure
    // must be serialized in-band in the Responses shape.
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            readDSResponse: async () => ({
                content: '', reasoningContent: '', messageId: null, finishReason: null,
                modelError: { type: 'error', content: 'context too long', finish_reason: null },
            }),
        });
        await handlers.handleResponses(req, res, JSON.stringify({
            input: 'hi',
            stream: true,
        }), deps);
        assert.equal(res.statusCode, 200);
        const body = res.body();
        assert.match(body, /event: response.failed/);
        assert.match(body, /context_length_exceeded/);
        assert.match(body, /[DONE]/);
    });
});

test('handleChatCompletions: an anonymous request deletes its ephemeral session', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const deleted = [];
        sessions.setRemoteSessionDeleter((accountId, sessionId) => { deleted.push(sessionId); });
        try {
            const res = fakeRes();
            // No session header => ephemeral: a fresh remote session is created
            // for this one request and must be forgotten afterwards.
            await handlers.handleChatCompletions(fakeReq(), res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), withDeps());
            assert.equal(res.statusCode, 200);
            // The fake upstream never creates a remote id, so there is nothing
            // upstream to delete here; the point is that the ephemeral local
            // session is gone. With a real upstream session, the same
            // resetRemoteSession() call deletes the remote chat (see the
            // resetRemoteSession deleter tests in sessions.test.js).
            assert.equal(sessions.getSessionCount(), 0, 'the ephemeral local session must be deleted');
        } finally {
            sessions.setRemoteSessionDeleter(null);
        }
    });
});

test('handleChatCompletions: a request with a session id keeps its session', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const deleted = [];
        sessions.setRemoteSessionDeleter((accountId, sessionId) => { deleted.push(sessionId); });
        try {
            const res = fakeRes();
            await handlers.handleChatCompletions(fakeReq({ headers: { 'x-session-id': 'keep-me' } }), res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), withDeps());
            assert.equal(res.statusCode, 200);
            assert.ok(sessions.getSessions().has('keep-me'), 'a named session must survive the request');
            assert.deepEqual(deleted, [], 'no upstream delete for a named session');
        } finally {
            sessions.setRemoteSessionDeleter(null);
        }
    });
});

test('handleResponses: a post-commit overflow is NOT the legacy event: error frame', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const deps = withDeps({
            readDSResponse: async () => ({
                content: '', reasoningContent: '', messageId: null, finishReason: null,
                modelError: { type: 'error', content: 'prompt is too long', finish_reason: null },
            }),
        });
        await handlers.handleResponses(req, res, JSON.stringify({ input: 'hi', stream: true }), deps);
        assert.doesNotMatch(res.body(), /event: error/);
    });
});
