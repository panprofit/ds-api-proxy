'use strict';
// Unit tests for the extracted request handlers. These exercise the pure-ish
// pieces (agent-id resolution, body reading) without starting the HTTP server
// or loading auth config.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const handlers = require('../lib/handlers');
const sessions = require('../lib/sessions');

// --- resolveAgentId ---------------------------------------------------------

function fakeReq({ headers = {}, remoteAddress = '10.0.0.9' } = {}) {
    return { headers, socket: { remoteAddress } };
}

test('resolveAgentId: prefers x-agent-session header', () => {
    const id = handlers.resolveAgentId(fakeReq({ headers: { 'x-agent-session': 'sess-1' } }), {});
    assert.equal(id, 'sess-1');
});

test('resolveAgentId: falls through the affinity header list', () => {
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { 'x-session-affinity': 'a' } }), {}), 'a');
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { 'x-session-id': 'b' } }), {}), 'b');
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { session_id: 'c' } }), {}), 'c');
    assert.equal(handlers.resolveAgentId(fakeReq({ headers: { 'x-client-request-id': 'd' } }), {}), 'd');
});

test('resolveAgentId: falls back to body session/user', () => {
    assert.equal(handlers.resolveAgentId(fakeReq(), { session: 'bs' }), 'bs');
    assert.equal(handlers.resolveAgentId(fakeReq(), { user: 'bu' }), 'bu');
});

test('resolveAgentId: localhost falls back to dev-agent', () => {
    assert.equal(handlers.resolveAgentId(fakeReq({ remoteAddress: '127.0.0.1' }), {}), 'dev-agent');
    assert.equal(handlers.resolveAgentId(fakeReq({ remoteAddress: '::1' }), {}), 'dev-agent');
    assert.equal(handlers.resolveAgentId(fakeReq({ remoteAddress: '::ffff:127.0.0.1' }), {}), 'dev-agent');
});

test('resolveAgentId: remote address is used when nothing else is set', () => {
    assert.equal(handlers.resolveAgentId(fakeReq({ remoteAddress: '10.0.0.9' }), {}), '10.0.0.9');
});

// --- resolveThinkingEnabled ------------------------------------------------

test('resolveThinkingEnabled: absent reasoning_effort -> disabled', () => {
    assert.equal(handlers.resolveThinkingEnabled({}), false);
    assert.equal(handlers.resolveThinkingEnabled({ messages: [] }), false);
});

test('resolveThinkingEnabled: any present reasoning_effort -> enabled', () => {
    for (const effort of ['low', 'medium', 'high', 'none', '', null, false]) {
        assert.equal(handlers.resolveThinkingEnabled({ reasoning_effort: effort }), true, String(effort));
    }
});

// --- readRequestBody --------------------------------------------------------

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
    // The router needs the connection alive to write its 413; destroying it
    // here would make the client see ECONNRESET instead of a status code.
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

test('readRequestBody: times out and destroys the socket when the body never ends', async () => {
    // A client that opens the request but never finishes the body must not hold
    // the handler forever: the read times out, the socket is torn down and the
    // caller is told timedOut so it can reply 408.
    const req = new EventEmitter();
    let destroyed = false;
    req.destroy = () => { destroyed = true; };
    // readRequestBody's timeout timer is unref'd, so keep the loop alive with a
    // real (ref'd) timer while we await the read timeout.
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
    assert.equal(destroyed, true, 'the stalled socket must be destroyed on timeout');
});

// --- parseChatRequest -------------------------------------------------------

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

test('readRequestBody: measures the cap in bytes, not UTF-16 code units', async () => {
    // A 2-byte char is 1 JS string unit but 2 bytes; a 4-byte emoji is 2 units
    // but 4 bytes. The cap must count bytes.
    const twoByte = '\u00e9'; // 2 bytes, .length === 1
    const { tooLarge } = await handlers.readRequestBody(requestWith([twoByte.repeat(4)]), 6);
    assert.equal(tooLarge, true, '8 bytes should exceed a 6-byte cap');
});

test('readRequestBody: preserves multibyte chars split across chunk boundaries', async () => {
    // Emoji split byte-wise across two chunks. Decoding each chunk separately
    // would corrupt it; buffering then decoding must not.
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

// --- sendOpenAIStream -------------------------------------------------------

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

// --- startStreamKeepAlive ---------------------------------------------------

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

// --- applyCors --------------------------------------------------------------

const config = require('../lib/config');

test('applyCors: reflects the request Origin when no allowlist is configured', () => {
    config.reload({});
    const res = fakeRes();
    handlers.applyCors({ headers: { origin: 'https://app.example' } }, res);
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://app.example');
});

test('applyCors: only allows origins on the allowlist', () => {
    process.env.DS_ALLOWED_ORIGINS = 'https://ok.example';
    config.reload();
    try {
        const ok = fakeRes();
        handlers.applyCors({ headers: { origin: 'https://ok.example' } }, ok);
        assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://ok.example');

        const blocked = fakeRes();
        handlers.applyCors({ headers: { origin: 'https://evil.example' } }, blocked);
        assert.equal(blocked.headers['Access-Control-Allow-Origin'], undefined);
    } finally {
        delete process.env.DS_ALLOWED_ORIGINS;
        config.reload();
    }
});

test('applyCors: denies all browser origins on a non-loopback bind with no allowlist', () => {
    config.reload({ HOST: '0.0.0.0' });
    try {
        const res = fakeRes();
        handlers.applyCors({ headers: { origin: 'https://app.example' } }, res);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
        // Vary is still emitted so shared caches keep variants separate.
        assert.equal(res.headers['Vary'], 'Origin');
    } finally {
        config.reload();
    }
});

// --- writeError -------------------------------------------------------------

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
    // A timeout with an active session must surface the failed session details
    // so the operator can see which conversation was dropped.
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
