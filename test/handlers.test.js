'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const handlers = require('../lib/handlers');
const sessions = require('../lib/sessions');

function fakeReq({ headers = {}, remoteAddress = '10.0.0.9' } = {}) {
    return { headers, socket: { remoteAddress } };
}

test('resolveAgentId: prefers x-agent-session header', () => {
    const r = handlers.resolveAgentId(fakeReq({ headers: { 'x-agent-session': 'sess-1' } }), {});
    assert.deepEqual(r, { agentId: 'sess-1', ephemeral: false });
});

test('resolveAgentId: falls through the affinity header list', () => {
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { 'x-session-affinity': 'a' } }), {}).agentId, 'a');
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { 'x-session-id': 'b' } }), {}).agentId, 'b');
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { session_id: 'c' } }), {}).agentId, 'c');
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { 'x-client-request-id': 'd' } }), {}).agentId, 'd');
});

test('resolveAgentId: falls back to body session/user', () => {
    assert.equal(handlers.resolveAgentId(fakeReq(), { session: 'bs' }).agentId, 'bs');
    assert.equal(handlers.resolveAgentId(fakeReq(), { user: 'bu' }).agentId, 'bu');
});

test('resolveAgentId: no session id yields a unique ephemeral id', () => {
    const a = handlers.resolveAgentId(fakeReq({ remoteAddress: '127.0.0.1' }), {});
    const b = handlers.resolveAgentId(fakeReq({ remoteAddress: '127.0.0.1' }), {});
    assert.equal(a.ephemeral, true);
    assert.match(a.agentId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(a.agentId, b.agentId, 'anonymous requests must not share a session');
});

test('resolveAgentId: ignoreAgentSession forces ephemeral even when a session header is sent', () => {
    const config = require('../lib/config');
    config.reload({ DS_IGNORE_AGENT_SESSION: '1' });
    try {
        const r = handlers.resolveAgentId(fakeReq({ headers: { 'x-agent-session': 'sess-1' } }), { session: 'bs' });
        assert.equal(r.ephemeral, true);
        assert.match(r.agentId, /^[0-9a-f-]{36}$/i);
    } finally {
        config.reload({});
    }
});

test('resolveThinkingEnabled: absent reasoning_effort -> disabled', () => {
    assert.equal(handlers.resolveThinkingEnabled({}), false);
    assert.equal(handlers.resolveThinkingEnabled({ messages: [] }), false);
});

test('resolveThinkingEnabled: none and nullish efforts stay disabled', () => {
    for (const effort of ['none', null, undefined]) {
        assert.equal(handlers.resolveThinkingEnabled({ reasoning_effort: effort }), false, String(effort));
    }
});

test('resolveThinkingEnabled: enabling efforts turn thinking on', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max']) {
        assert.equal(handlers.resolveThinkingEnabled({ reasoning_effort: effort }), true, effort);
    }
});

test('resolveThinkingEnabled: explicit thinking overrides reasoning_effort', () => {
    assert.equal(handlers.resolveThinkingEnabled({
        thinking: { type: 'disabled' },
        reasoning_effort: 'max',
    }), false);
    assert.equal(handlers.resolveThinkingEnabled({
        thinking: { type: 'enabled' },
        reasoning_effort: 'none',
    }), true);
    assert.equal(handlers.resolveThinkingEnabled({ thinking: { type: 'adaptive' } }), true);
});

test('parseChatRequest: rejects unknown thinking and effort values', () => {
    for (const body of [
        { messages: [], reasoning_effort: 'urgent' },
        { messages: [], reasoning_effort: '' },
        { messages: [], thinking: 'enabled' },
        { messages: [], thinking: { type: 'sometimes' } },
    ]) {
        assert.equal(handlers.parseChatRequest(JSON.stringify(body)).ok, false, JSON.stringify(body));
    }
});

function requestWith(chunks, { errorAfter = false } = {}) {
    const req = new EventEmitter();
    process.nextTick(() => {
        for (const c of chunks) req.emit('data', Buffer.from(c));
        if (errorAfter) req.emit('error', new Error('boom'));
        else req.emit('end');
    });
    req.destroy = () => {};
    return req;
}

test('readRequestBody: accumulates chunks', async () => {
    const { body, tooLarge } = await handlers.readRequestBody(requestWith(['he', 'llo']));
    assert.equal(body, 'hello');
    assert.equal(tooLarge, false);
});

test('readRequestBody: marks tooLarge past the cap', async () => {
    const { tooLarge } = await handlers.readRequestBody(requestWith(['xxxxx', 'yyyyy']), 3);
    assert.equal(tooLarge, true);
});

test('readRequestBody: a size violation does not destroy the socket', async () => {

    const req = requestWith(['xxxxx', 'yyyyy']);
    let destroyed = false;
    req.destroy = () => { destroyed = true; };
    const { tooLarge, body } = await handlers.readRequestBody(req, 3);
    assert.equal(tooLarge, true);
    assert.equal(body, '');
    assert.equal(destroyed, false, 'readRequestBody must not destroy the socket on overflow');
});

test('readRequestBody: drains and removes its data listener on overflow', async () => {
    const req = requestWith(['x'.repeat(10)]);
    let resumed = false;
    req.resume = () => { resumed = true; };
    const { tooLarge } = await handlers.readRequestBody(req, 3);
    assert.equal(tooLarge, true);
    assert.equal(resumed, true, 'the remaining body should be drained, not left unread');
    assert.equal(req.listenerCount('data'), 0, 'the data listener must be removed after overflow');
});

test('readRequestBody: a stream error is reported as errored, not tooLarge', async () => {
    const { tooLarge, errored } = await handlers.readRequestBody(requestWith(['a'], { errorAfter: true }));
    assert.equal(tooLarge, false, 'a socket error must not masquerade as a 413 payload_too_large');
    assert.equal(errored, true);
});

test('readRequestBody: times out without destroying the socket (router writes the 408)', async () => {

    const req = new EventEmitter();
    let destroyed = false;
    req.destroy = () => { destroyed = true; };
    let resumed = false;
    req.resume = () => { resumed = true; };

    const keepAlive = setInterval(() => {}, 1000);
    let result;
    try {
        result = await handlers.readRequestBody(req, 1024, { timeoutMs: 5 });
    } finally {
        clearInterval(keepAlive);
    }
    assert.equal(result.timedOut, true);
    assert.equal(result.tooLarge, false);
    assert.equal(result.errored, false);
    assert.equal(result.body, '');
    assert.equal(destroyed, false, 'the socket must survive so the router can send 408');
    assert.equal(resumed, true, 'the remaining body should be drained after a timeout');
});

test('parseChatRequest: rejects a non-object body', () => {
    for (const bad of ['"str"', '42', 'true', 'null']) {
        const parsed = handlers.parseChatRequest(bad);
        assert.equal(parsed.ok, false, bad);
        assert.equal(parsed.error.type, 'invalid_request_error');
    }
});

test('parseChatRequest: rejects non-array messages and tools', () => {
    const badMessages = handlers.parseChatRequest(JSON.stringify({ messages: 'nope' }));
    assert.equal(badMessages.ok, false);
    assert.match(badMessages.error.message, /messages must be an array/);

    const badTools = handlers.parseChatRequest(JSON.stringify({ tools: {} }));
    assert.equal(badTools.ok, false);
    assert.match(badTools.error.message, /tools must be an array/);
});

test('parseChatRequest: accepts an empty object and arrays', () => {
    assert.equal(handlers.parseChatRequest('{}').ok, true);
    assert.equal(handlers.parseChatRequest(JSON.stringify({ messages: [], tools: [] })).ok, true);
});

test('parseChatRequest: rejects role=tool without a tool_call_id', () => {
    const parsed = handlers.parseChatRequest(JSON.stringify({ messages: [{ role: 'tool', content: 'x' }] }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.message, /messages\[0\] role 'tool' requires a 'tool_call_id'/);
});

test('parseChatRequest: rejects role=function without a name', () => {
    const parsed = handlers.parseChatRequest(JSON.stringify({ messages: [{ role: 'user', content: 'a' }, { role: 'function', content: 'b' }] }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.error.message, /messages\[1\] role 'function' requires a 'name'/);
});

test('parseChatRequest: skips null/non-object message entries', () => {
    const parsed = handlers.parseChatRequest(JSON.stringify({ messages: [null, 42, { role: 'assistant', content: 'ok' }] }));
    assert.equal(parsed.ok, true);
});

test('readRequestBody: measures the cap in bytes, not UTF-16 code units', async () => {

    const twoByte = '\u00e9';
    const { tooLarge } = await handlers.readRequestBody(requestWith([twoByte.repeat(4)]), 6);
    assert.equal(tooLarge, true, '8 bytes should exceed a 6-byte cap');
});

test('readRequestBody: preserves multibyte chars split across chunk boundaries', async () => {

    const emoji = Buffer.from('\u{1F600}', 'utf8');
    const a = emoji.subarray(0, 2);
    const b = emoji.subarray(2);
    const req = new EventEmitter();
    process.nextTick(() => { req.emit('data', a); req.emit('data', b); req.emit('end'); });
    req.destroy = () => {};
    const { body, tooLarge } = await handlers.readRequestBody(req);
    assert.equal(tooLarge, false);
    assert.equal(body, '\u{1F600}');
});

function fakeRes() {
    return {
        chunks: [],
        statusCode: null,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        flushHeaders() {},
        write(s) { this.chunks.push(s); },
        end() { this.ended = true; },
    };
}

test('sendOpenAIStream: text response emits content chunks + stop + [DONE]', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-1', created: 1,
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
    });
    const joined = res.chunks.join('');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.ok(joined.includes('"content":"hi"'));
    assert.ok(joined.includes('"finish_reason":"stop"'));
    assert.ok(joined.includes('data: [DONE]'));
    assert.equal(res.ended, true);
});

test('sendOpenAIStream: every chunk carries the response model', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-m', created: 7, model: 'my-model',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
    });
    const models = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c).model);
    assert.ok(models.length > 0);
    assert.ok(models.every(m => m === 'my-model'));
});

test('sendOpenAIStream: tool_calls emit a tool_calls finish reason', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-2', created: 2,
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] } }],
    });
    const joined = res.chunks.join('');
    assert.ok(joined.includes('"tool_calls"'));
    assert.ok(joined.includes('"finish_reason":"tool_calls"'));
});

test('sendOpenAIStream: leads with a role delta before content', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-3', created: 3,
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
    });
    const first = JSON.parse(res.chunks[0].replace(/^data: /, ''));
    assert.deepEqual(first.choices[0].delta, { role: 'assistant', content: '' });
});

test('sendOpenAIStream: streams tool-call arguments incrementally by index', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-4', created: 4,
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    });
    const deltas = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c).choices[0].delta);
    const head = deltas.find(d => d.tool_calls && d.tool_calls[0].id);
    assert.equal(head.tool_calls[0].index, 0);
    assert.equal(head.tool_calls[0].function.name, 'f');
    const argFragments = deltas
        .filter(d => d.tool_calls && d.tool_calls[0].function && d.tool_calls[0].function.arguments)
        .map(d => d.tool_calls[0].function.arguments)
        .join('');
    assert.equal(argFragments, '{"a":1}');
});

test('sendOpenAIStream: reasoning_content is streamed as its own deltas', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-5', created: 5,
        choices: [{ message: { role: 'assistant', content: 'answer', reasoning_content: 'thinking…' } }],
    });
    const deltas = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c).choices[0].delta);
    const reasoning = deltas
        .filter(d => d.reasoning_content)
        .map(d => d.reasoning_content)
        .join('');
    assert.equal(reasoning, 'thinking…');
});

test('sendOpenAIStream: includeUsage appends a usage-only frame', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-6', created: 6,
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }, { includeUsage: true });
    const usageFrame = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c))
        .find(f => Array.isArray(f.choices) && f.choices.length === 0);
    assert.ok(usageFrame, 'expected a usage-only chunk');
    assert.equal(usageFrame.usage.total_tokens, 4);
});

test('sendOpenAIStream: a length finish_reason is preserved', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-7', created: 7,
        choices: [{ message: { role: 'assistant', content: 'trunc' }, finish_reason: 'length' }],
    });
    const frames = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c));
    const final = frames.find(f => f.choices[0].finish_reason);
    assert.equal(final.choices[0].finish_reason, 'length');
});

test('startStreamKeepAlive: disabled for interval 0', () => {
    const res = fakeRes();
    const stop = handlers.startStreamKeepAlive(res, 0);
    assert.equal(typeof stop, 'function');
    stop();
    assert.equal(res.chunks.length, 0);
});

test('startStreamKeepAlive: disabled when res cannot write', () => {
    const stop = handlers.startStreamKeepAlive({}, 1000);
    assert.equal(typeof stop, 'function');
    stop();
});

test('startStreamKeepAlive: writes a keepalive frame on the interval', async () => {
    const res = fakeRes();
    const stop = handlers.startStreamKeepAlive(res, 5);
    await new Promise(r => setTimeout(r, 20));
    stop();
    assert.ok(res.chunks.some(c => c === ': keepalive\n\n'), 'expected a keepalive comment frame');
});

test('startStreamKeepAlive: a throwing write does not crash the timer', async () => {
    const res = fakeRes();
    res.write = () => { throw new Error('gone'); };
    const stop = handlers.startStreamKeepAlive(res, 5);
    await new Promise(r => setTimeout(r, 20));
    stop();
});

const config = require('../lib/config');

test('applyCors: reflects the request Origin when no allowlist is configured', () => {
    config.reload({});
    const res = fakeRes();
    handlers.applyCors({ headers: { origin: 'https://app.example' } }, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.example');
});

test('applyCors: only allows origins on the allowlist', () => {
    config.reload({ DS_ALLOWED_ORIGINS: 'https://ok.example' });
    try {
        const ok = fakeRes();
        handlers.applyCors({ headers: { origin: 'https://ok.example' } }, ok);
        assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://ok.example');

        const blocked = fakeRes();
        handlers.applyCors({ headers: { origin: 'https://evil.example' } }, blocked);
        assert.equal(blocked.headers['Access-Control-Allow-Origin'], undefined);
    } finally {
        config.reload();
    }
});

test('applyCors: denies all browser origins on a non-loopback bind with no allowlist', () => {
    config.reload({ HOST: '0.0.0.0' });
    try {
        const res = fakeRes();
        handlers.applyCors({ headers: { origin: 'https://app.example' } }, res);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);

        assert.equal(res.headers['Vary'], 'Origin');
    } finally {
        config.reload();
    }
});

function errorRes() {
    const res = fakeRes();
    res.headersSent = false;
    res.body = null;
    res.end = function (chunk) { if (chunk !== undefined) this.body = chunk; this.ended = true; };
    return res;
}

test('writeError: a plain error is written as a 500 JSON response', () => {
    const res = errorRes();
    handlers.writeError(res, new Error('boom'), { clientGone: false });
    assert.equal(res.statusCode, 500);
    const json = JSON.parse(res.body);
    assert.equal(json.error.type, 'server_error');
    assert.match(json.error.message, /boom/);
});

test('writeError: an explicit status and type are honored, plus Retry-After for 429', () => {
    const res = errorRes();
    const err = Object.assign(new Error('slow down'), { status: 429, type: 'rate_limit', retryAfter: 17 });
    handlers.writeError(res, err, { clientGone: false });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '17');
    assert.equal(JSON.parse(res.body).error.type, 'rate_limit');
});

test('writeError: a timeout is surfaced as 504 request_timeout', () => {
    const res = errorRes();
    const err = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    handlers.writeError(res, err, { clientGone: false });
    assert.equal(res.statusCode, 504);
    const json = JSON.parse(res.body);
    assert.equal(json.error.type, 'request_timeout');
});

test('writeError: when the client is gone nothing is written', () => {
    const res = errorRes();
    handlers.writeError(res, new Error('boom'), { clientGone: true });
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
});

test('writeError: after headers are sent the error is an in-band SSE frame', () => {
    const res = errorRes();
    res.headersSent = true;
    handlers.writeError(res, Object.assign(new Error('late'), { type: 'upstream_error' }), { clientGone: false });
    const body = res.chunks.join('');
    assert.match(body, /event: error/);
    assert.match(body, /\[DONE\]/);
    assert.equal(res.ended, true);
});

test('writeError: an aborted SSE write does not throw', () => {
    const res = errorRes();
    res.headersSent = true;
    res.write = () => { throw new Error('socket gone'); };
    assert.doesNotThrow(() => handlers.writeError(res, new Error('late'), { clientGone: false }));
    assert.equal(res.ended, true);
});

test('writeError: a timeout resets the active session and reports it', () => {

    const res = errorRes();
    const session = sessions.createSession();
    session.id = 'remote-9';
    session.messageCount = 4;
    session.accountId = 'acct-1';
    const err = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    handlers.writeError(res, err, { clientGone: false, activeSession: session, activeAgentId: 'agent-1' });
    assert.equal(res.statusCode, 504);
    const json = JSON.parse(res.body);
    assert.equal(json.error.type, 'request_timeout');
    assert.equal(json.error.agent, 'agent-1');
    assert.equal(json.error.failed_session_id, 'remote-9');
    assert.equal(json.error.message_count, 4);
    assert.equal(json.error.account, 'acct-1');
    assert.equal(session.id, null, 'the failed session must be reset');
});

test('sendOpenAIStream: no obfuscation field by default', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-o1', created: 1,
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
    });
    const joined = res.chunks.join('');
    assert.ok(!joined.includes('obfuscation'));
});

test('sendOpenAIStream: obfuscation pads every choice-bearing chunk', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-o2', created: 2,
        choices: [{ message: { role: 'assistant', content: 'hello world' } }],
    }, { includeObfuscation: true });
    const chunks = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c));
    const withChoices = chunks.filter(c => c.choices && c.choices.length > 0);
    assert.ok(withChoices.length > 0);
    assert.ok(withChoices.every(c => typeof c.obfuscation === 'string' && c.obfuscation.length > 0));

    assert.ok(withChoices.every(c => c.choices[0].delta.obfuscation === undefined));
});

test('sendOpenAIStream: obfuscation padding is random per chunk', () => {
    const res = fakeRes();
    handlers.sendOpenAIStream(res, {
        id: 'ds-o3', created: 3,
        choices: [{ message: { role: 'assistant', content: 'x'.repeat(200) } }],
    }, { includeObfuscation: true });
    const pads = res.chunks
        .map(c => c.replace(/^data: /, '').trim())
        .filter(c => c && c !== '[DONE]')
        .map(c => JSON.parse(c))
        .filter(c => c.choices && c.choices.length > 0)
        .map(c => c.obfuscation);
    assert.ok(pads.length >= 2);
    assert.ok(new Set(pads).size > 1, 'padding must differ between chunks');
});

test('resolveSearchEnabled: web_search_options forces search on', () => {
    assert.equal(handlers.resolveSearchEnabled({ web_search_options: {} }, { defaultSearchEnabled: false }), true);
    assert.equal(handlers.resolveSearchEnabled({ web_search_options: {} }, { defaultSearchEnabled: true }), true);
});

test('resolveSearchEnabled: absent options follow the config default', () => {
    assert.equal(handlers.resolveSearchEnabled({}, { defaultSearchEnabled: true }), true);
    assert.equal(handlers.resolveSearchEnabled({}, { defaultSearchEnabled: false }), false);
});

test('resolveSearchEnabled: null web_search_options does not force on', () => {
    assert.equal(handlers.resolveSearchEnabled({ web_search_options: null }, { defaultSearchEnabled: false }), false);
});

test('normalizeStop: string -> single-element array', () => {
    assert.deepEqual(handlers.normalizeStop('STOP'), ['STOP']);
});

test('normalizeStop: array is kept, empties/dupes dropped', () => {
    assert.deepEqual(handlers.normalizeStop(['a', '', 'a', 'b', null, 3]), ['a', 'b']);
});

test('normalizeStop: absent / invalid -> []', () => {
    assert.deepEqual(handlers.normalizeStop(undefined), []);
    assert.deepEqual(handlers.normalizeStop(null), []);
    assert.deepEqual(handlers.normalizeStop(42), []);
});

test('resolveTools: keeps the tools array and maps legacy functions', () => {
    const tools = [{ type: 'function', function: { name: 'a' } }];
    assert.deepEqual(handlers.resolveTools({ tools }), tools);
    assert.deepEqual(
        handlers.resolveTools({ functions: [{ name: 'legacy', parameters: {} }, { description: 'no name' }] }),
        [{ type: 'function', function: { name: 'legacy', parameters: {} } }]
    );
    assert.deepEqual(handlers.resolveTools({}), []);
});

test('resolveToolChoice: normalizes strings, named objects and legacy function_call', () => {
    assert.equal(handlers.resolveToolChoice({}), 'auto');
    assert.equal(handlers.resolveToolChoice({ tool_choice: 'auto' }), 'auto');
    assert.equal(handlers.resolveToolChoice({ tool_choice: 'none' }), 'none');
    assert.equal(handlers.resolveToolChoice({ tool_choice: 'required' }), 'required');
    assert.deepEqual(
        handlers.resolveToolChoice({ tool_choice: { type: 'function', function: { name: 'read' } } }),
        { name: 'read' }
    );
    assert.deepEqual(handlers.resolveToolChoice({ function_call: { name: 'write' } }), { name: 'write' });
    assert.equal(handlers.resolveToolChoice({ function_call: 'none' }), 'none');
    assert.equal(handlers.resolveToolChoice({ tool_choice: 'bogus' }), 'auto');
});

test('parseChatRequest: validates functions and tool_choice types', () => {
    assert.match(handlers.parseChatRequest(JSON.stringify({ functions: {} })).error.message, /functions must be an array/);
    assert.match(handlers.parseChatRequest(JSON.stringify({ tool_choice: 3 })).error.message, /tool_choice must be/);
    assert.equal(handlers.parseChatRequest(JSON.stringify({ functions: [], tool_choice: 'none' })).ok, true);
});
