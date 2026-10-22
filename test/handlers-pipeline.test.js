'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const handlers = require('../lib/handlers');
const sessions = require('../lib/sessions');
const accounts = require('../lib/accounts');

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

function askCapture() {
    let captured = null;
    return {
        get args() { return captured; },
        askDSStream: async (args) => {
            captured = args;
            return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false };
        },
    };
}

test('handleChatCompletions: thinking + tools prompts plain JSON tool calls', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const capture = askCapture();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high',
            tools: [{ type: 'function', function: { name: 'read' } }],
        }), withDeps({ askDSStream: capture.askDSStream }));
        assert.equal(res.statusCode, 200);
        assert.ok(capture.args.prompt.includes('<tool_call>\n{"name":"$TOOL_NAME"'));
        assert.ok(!capture.args.prompt.includes('\uFF5CDSML\uFF5C'));
    });
});

test('handleChatCompletions: forwards the reasoning effort as V4.1 prompt text', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const capture = askCapture();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'max',
        }), withDeps({ askDSStream: capture.askDSStream }));
        assert.equal(res.statusCode, 200);
        assert.match(capture.args.prompt, /^Reasoning Effort: 100 \(range 1-100/);
    });
});

test('handleChatCompletions: reasoning_effort none adds no effort prompt', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const capture = askCapture();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'none',
        }), withDeps({ askDSStream: capture.askDSStream }));
        assert.equal(res.statusCode, 200);
        assert.ok(!capture.args.prompt.includes('Reasoning Effort:'));
    });
});

test('handleChatCompletions: non-thinking tools also use the JSON tool-call prompt', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const req = fakeReq();
        const res = fakeRes();
        const capture = askCapture();
        await handlers.handleChatCompletions(req, res, JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'read' } }],
        }), withDeps({ askDSStream: capture.askDSStream }));
        assert.equal(res.statusCode, 200);
        assert.ok(!capture.args.prompt.includes('\uFF5CDSML\uFF5C calls'));
        assert.ok(capture.args.prompt.includes('<tool_call>\n{"name":"$TOOL_NAME"'));
    });
});

test('handleChatCompletions: toggling thinking keeps the session and the JSON tool format', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const prompts = [];
        const askDSStream = async (args) => {
            prompts.push(args.prompt);
            const session = sessions.getOrCreateAgentSession(args.agentId);
            if (!session.id) {
                session.id = `sess-${prompts.length}`;
                session.messageCount = 1;
            }
            return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false };
        };
        const send = (body, headers = { 'x-agent-session': 'agent-x' }) => {
            const req = fakeReq({ headers });
            const res = fakeRes();
            return handlers.handleChatCompletions(req, res, JSON.stringify(body), withDeps({ askDSStream }))
                .then(() => res);
        };
        const tools = [{ type: 'function', function: { name: 'read' } }];
        await send({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high', tools });
        await send({ messages: [{ role: 'user', content: 'again' }], tools });
        assert.equal(prompts.length, 2);
        assert.ok(prompts[0].includes('<tool_call>'));
        assert.ok(!prompts[0].includes('\uFF5CDSML\uFF5C'));
        assert.ok(!prompts[1].includes('\uFF5CDSML\uFF5C'));
        assert.equal(sessions.getOrCreateAgentSession('agent-x').id, 'sess-1');
    });
});

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

        assert.equal(res.json().error.type, 'empty_response');
    });
});

test('handleChatCompletions: recovery failure after SSE commit writes an error frame', async () => {

    const acct = makeAccount('a1');
    await withAccounts([acct], async () => {
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

test('handleChatCompletions: a prompt rollover resets the session before the prompt is built', async () => {

    await withAccounts([makeAccount('a1')], async () => {
        const session = sessions.getOrCreateAgentSession('dev-agent');
        session.id = 'remote-1';
        session.messageCount = 100;

        session.createdAt = Date.now() - 3 * 60 * 60 * 1000;
        session.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000;

        const req = fakeReq({ headers: { 'x-session-id': 'dev-agent' } });
        const res = fakeRes();
        await handlers.handleChatCompletions(req, res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), withDeps());
        assert.equal(res.statusCode, 200);
        assert.equal(session.id, null, 'the rolled-over session should have been reset');
    });
});

test('handleChatCompletions: clientGone during recovery returns without writing', async () => {

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

test('handleResponses: a post-commit context overflow emits response.failed for compaction', async () => {

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

            await handlers.handleChatCompletions(fakeReq(), res, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), withDeps());
            assert.equal(res.statusCode, 200);

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
