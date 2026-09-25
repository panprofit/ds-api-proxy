'use strict';
// Unit tests for lib/responses.js — Responses API request/response
// translation. Focus: image attachment preservation through normalizeInput /
// normalizeContentParts, which is what lets /v1/responses upload files.

const test = require('node:test');
const assert = require('node:assert/strict');

const responses = require('../lib/responses');

// --- normalizeContentParts --------------------------------------------------

test('normalizeContentParts: text-only parts collapse to a string', () => {
    const out = responses.normalizeContentParts([
        { type: 'input_text', text: 'a' },
        { type: 'output_text', text: 'b' },
        { type: 'text', text: 'c' },
    ]);
    assert.equal(out, ['a', 'b', 'c'].join('\n'));
    assert.equal(typeof out, 'string');
});

test('normalizeContentParts: string and nullish pass through', () => {
    assert.equal(responses.normalizeContentParts('hi'), 'hi');
    assert.equal(responses.normalizeContentParts(null), '');
    assert.equal(responses.normalizeContentParts(undefined), '');
});

test('normalizeContentParts: input_image with a string image_url is preserved', () => {
    const out = responses.normalizeContentParts([
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
    assert.ok(Array.isArray(out), 'image parts must keep content an array');
    assert.deepEqual(out[0], { type: 'text', text: 'look' });
    assert.deepEqual(out[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
});

test('normalizeContentParts: input_image with an object image_url is normalized', () => {
    const out = responses.normalizeContentParts([
        { type: 'input_image', image_url: { url: 'https://example.com/a.png' }, detail: 'high' },
    ]);
    assert.deepEqual(out, [
        { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
    ]);
});

test('normalizeContentParts: chat-style image_url parts pass through as images', () => {
    const out = responses.normalizeContentParts([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    assert.deepEqual(out, [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
});

test('normalizeContentParts: a bare url field is accepted', () => {
    const out = responses.normalizeContentParts([{ type: 'input_image', url: 'https://x/y.png' }]);
    assert.deepEqual(out, [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]);
});

test('normalizeContentParts: image without a usable url is dropped', () => {
    assert.equal(responses.normalizeContentParts([{ type: 'input_image' }]), '');
});

test('normalizeContentParts: images-only content omits the text part', () => {
    const out = responses.normalizeContentParts([
        { type: 'input_image', image_url: 'https://x/y.png' },
    ]);
    assert.deepEqual(out, [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]);
});

// --- normalizeInput ---------------------------------------------------------

test('normalizeInput: a message with an image keeps content as an array', () => {
    const messages = responses.normalizeInput([{
        type: 'message',
        role: 'user',
        content: [
            { type: 'input_text', text: 'what is this?' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
    }]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.ok(Array.isArray(messages[0].content));
    assert.deepEqual(messages[0].content, [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
});

test('normalizeInput: a text-only message keeps content as a string', () => {
    const messages = responses.normalizeInput([{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
    }]);
    assert.equal(messages[0].content, 'hello');
});

test('normalizeInput: accepts a bare role/content object', () => {
    const messages = responses.normalizeInput([{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://x/y.png' }],
    }]);
    assert.ok(Array.isArray(messages[0].content));
});

// --- toInternalParams -------------------------------------------------------

test('toInternalParams: image parts survive the full translation', () => {
    const internal = responses.toInternalParams({
        input: [{
            type: 'message',
            role: 'user',
            content: [
                { type: 'input_text', text: 'see' },
                { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
            ],
        }],
    });
    const content = internal.messages[0].content;
    assert.ok(Array.isArray(content));
    const image = content.find(p => p.type === 'image_url');
    assert.equal(image.image_url.url, 'data:image/jpeg;base64,AAAA');
});

// --- parseResponsesRequest --------------------------------------------------

test('parseResponsesRequest: rejects malformed JSON and non-object bodies', () => {
    assert.equal(responses.parseResponsesRequest('{').ok, false);
    assert.equal(responses.parseResponsesRequest('[]').ok, false);
    assert.equal(responses.parseResponsesRequest('"x"').ok, false);
});

test('parseResponsesRequest: validates input and tools types', () => {
    assert.equal(responses.parseResponsesRequest('{"input":123}').ok, false);
    assert.equal(responses.parseResponsesRequest('{"tools":"x"}').ok, false);
    assert.equal(responses.parseResponsesRequest('{"input":"hi","tools":[]}').ok, true);
});

test('parseResponsesRequest: input may be an array of message items', () => {
    const parsed = responses.parseResponsesRequest(JSON.stringify({
        input: [{ type: 'message', role: 'user', content: 'hi' }],
    }));
    assert.equal(parsed.ok, true);
});

// --- sendResponseStream -----------------------------------------------------

// Minimal fake ServerResponse that records written chunks and events.
function makeFakeRes() {
    const chunks = [];
    const res = {
        headersSent: false,
        statusCode: null,
        headers: null,
        ended: false,
        chunks,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        flushHeaders() {},
        write(chunk) { chunks.push(String(chunk)); },
        end() { this.ended = true; },
        // Parse the SSE chunks into [{ event, data }] for assertions.
        events() {
            const out = [];
            const raw = chunks.join('');
            for (const block of raw.split('\n\n')) {
                const line = block.trim();
                if (!line || line === 'data: [DONE]') continue;
                const m = /^event: (\S+)\ndata: (.*)$/s.exec(line);
                if (m) out.push({ event: m[1], data: JSON.parse(m[2]) });
            }
            return out;
        },
        hasDone() { return chunks.join('').includes('data: [DONE]'); },
    };
    return res;
}

test('sendResponseStream: text response emits created -> deltas -> completed -> [DONE]', () => {
    const res = makeFakeRes();
    responses.sendResponseStream(res, { content: 'hello world', contextTokens: 10 });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(res.ended, true);
    assert.equal(res.hasDone(), true);

    const events = res.events();
    const names = events.map(e => e.event);
    assert.ok(names.includes('response.created'));
    assert.ok(names.includes('response.in_progress'));
    assert.ok(names.includes('response.output_item.added'));
    assert.ok(names.includes('response.content_part.added'));
    assert.ok(names.includes('response.output_text.delta'));
    assert.ok(names.includes('response.output_text.done'));
    assert.ok(names.includes('response.output_item.done'));
    assert.ok(names.includes('response.completed'));
    assert.ok(!names.includes('response.incomplete'));

    // Deltas concatenate back to the full content.
    const deltas = events.filter(e => e.event === 'response.output_text.delta').map(e => e.data.delta);
    assert.equal(deltas.join(''), 'hello world');

    // The final completed event carries the assembled output.
    const completed = events.find(e => e.event === 'response.completed');
    assert.equal(completed.data.response.status, 'completed');
    assert.equal(completed.data.response.output_text, 'hello world');
    assert.equal(completed.data.response.output[0].type, 'message');
    assert.equal(completed.data.response.output[0].content[0].text, 'hello world');
});

test('sendResponseStream: tool call emits function_call events and empty output_text', () => {
    const res = makeFakeRes();
    responses.sendResponseStream(res, {
        content: '',
        toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"x"}' },
        contextTokens: 5,
    });
    const events = res.events();
    const names = events.map(e => e.event);
    assert.ok(names.includes('response.function_call_arguments.delta'));
    assert.ok(names.includes('response.function_call_arguments.done'));
    assert.ok(!names.includes('response.output_text.delta'));

    const argDeltas = events.filter(e => e.event === 'response.function_call_arguments.delta').map(e => e.data.delta);
    assert.equal(argDeltas.join(''), '{"path":"x"}');

    const completed = events.find(e => e.event === 'response.completed');
    assert.equal(completed.data.response.output_text, '');
    assert.equal(completed.data.response.output[0].type, 'function_call');
    assert.equal(completed.data.response.output[0].name, 'read');
    assert.equal(completed.data.response.output[0].call_id, 'call_1');
});

test('sendResponseStream: reasoning content emits reasoning item before the message', () => {
    const res = makeFakeRes();
    responses.sendResponseStream(res, { content: 'answer', reasoningContent: 'thinking...', contextTokens: 3 });
    const events = res.events();
    const names = events.map(e => e.event);
    assert.ok(names.includes('response.reasoning_summary_part.added'));
    assert.ok(names.includes('response.reasoning_summary_text.delta'));
    assert.ok(names.includes('response.reasoning_summary_text.done'));

    const completed = events.find(e => e.event === 'response.completed');
    assert.equal(completed.data.response.output.length, 2);
    assert.equal(completed.data.response.output[0].type, 'reasoning');
    assert.equal(completed.data.response.output[1].type, 'message');
    assert.equal(completed.data.response.usage.output_tokens_details.reasoning_tokens, completed.data.response.output[0].summary[0].text.length > 0 ? completed.data.response.usage.output_tokens_details.reasoning_tokens : 0);
});

test('sendResponseStream: finishReason length -> incomplete terminal event', () => {
    const res = makeFakeRes();
    responses.sendResponseStream(res, { content: 'partial', finishReason: 'length' });
    const events = res.events();
    const names = events.map(e => e.event);
    assert.ok(names.includes('response.incomplete'));
    assert.ok(!names.includes('response.completed'));
    const terminal = events.find(e => e.event === 'response.incomplete');
    assert.equal(terminal.data.response.status, 'incomplete');
    assert.equal(terminal.data.response.incomplete_details.reason, 'max_output_tokens');
});

test('sendResponseStream: honors an explicit responseId', () => {
    const res = makeFakeRes();
    responses.sendResponseStream(res, { content: 'x' }, { responseId: 'resp_fixed' });
    const created = res.events().find(e => e.event === 'response.created');
    assert.equal(created.data.response.id, 'resp_fixed');
});

test('sendResponseStream: skips writeHead when headers already sent', () => {
    const res = makeFakeRes();
    res.headersSent = true;
    responses.sendResponseStream(res, { content: 'x' });
    assert.equal(res.statusCode, null);
    assert.equal(res.hasDone(), true);
});

test('sendResponseStream: always reports previous_response_id as null', () => {
    const res = makeFakeRes();
    responses.sendResponseStream(res, { content: 'x' });
    const created = res.events().find(e => e.event === 'response.created');
    assert.equal(created.data.response.previous_response_id, null);
});

// --- buildResponse ----------------------------------------------------------

test('buildResponse: plain text message with usage and completed status', () => {
    const built = responses.buildResponse({ content: 'hi there', contextTokens: 12 });
    assert.equal(built.object, 'response');
    assert.equal(built.status, 'completed');
    assert.equal(built.output_text, 'hi there');
    assert.equal(built.output.length, 1);
    assert.equal(built.output[0].type, 'message');
    assert.equal(built.output[0].role, 'assistant');
    assert.equal(built.output[0].content[0].text, 'hi there');
    assert.equal(typeof built.id, 'string');
    assert.equal(built.id.startsWith('resp_'), true);
    assert.equal(typeof built.usage.input_tokens, 'number');
    assert.equal(typeof built.usage.output_tokens, 'number');
    assert.equal(typeof built.usage.total_tokens, 'number');
});

test('buildResponse: tool call produces a function_call item and empty output_text', () => {
    const built = responses.buildResponse({
        content: '',
        toolCall: { id: 'call_42', name: 'read', arguments: '{"path":"a"}' },
        contextTokens: 3,
    });
    assert.equal(built.output_text, '');
    assert.equal(built.output.length, 1);
    assert.equal(built.output[0].type, 'function_call');
    assert.equal(built.output[0].name, 'read');
    assert.equal(built.output[0].call_id, 'call_42');
    assert.equal(built.output[0].status, 'completed');
});

test('buildResponse: tool call without an id gets a generated call_id', () => {
    const built = responses.buildResponse({
        toolCall: { name: 'bash', arguments: '{}' },
    });
    assert.equal(typeof built.output[0].call_id, 'string');
    assert.equal(built.output[0].call_id.length > 0, true);
});

test('buildResponse: reasoning content is emitted as a reasoning item first', () => {
    const built = responses.buildResponse({
        content: 'answer',
        reasoningContent: 'let me think',
        contextTokens: 5,
    });
    assert.equal(built.output.length, 2);
    assert.equal(built.output[0].type, 'reasoning');
    assert.equal(built.output[0].summary[0].text, 'let me think');
    assert.equal(built.output[1].type, 'message');
    assert.equal(built.output[1].content[0].text, 'answer');
});

test('buildResponse: reasoning + toolCall -> two items in order', () => {
    const built = responses.buildResponse({
        reasoningContent: 'thinking',
        toolCall: { id: 'c1', name: 'read', arguments: '{}' },
    });
    assert.equal(built.output.length, 2);
    assert.equal(built.output[0].type, 'reasoning');
    assert.equal(built.output[1].type, 'function_call');
});

test('buildResponse: finishReason length -> incomplete with details', () => {
    const built = responses.buildResponse({ content: 'partial', finishReason: 'length' });
    assert.equal(built.status, 'incomplete');
    assert.equal(built.incomplete_details.reason, 'max_output_tokens');
});

test('buildResponse: empty content yields an empty message content array', () => {
    const built = responses.buildResponse({ content: '' });
    assert.equal(built.output_text, '');
    assert.equal(built.output[0].type, 'message');
    assert.deepEqual(built.output[0].content, []);
    assert.equal(built.status, 'completed');
});

test('buildResponse: always reports previous_response_id as null', () => {
    const built = responses.buildResponse({ content: 'x' });
    assert.equal(built.previous_response_id, null);
});

// --- normalizeContentParts / maybeParsePartsArray ---------------------------

test('normalizeContentParts: parses a JSON-encoded parts array with images', () => {
    const out = responses.normalizeContentParts(JSON.stringify([
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'https://x/y.png' },
    ]));
    assert.ok(Array.isArray(out));
    assert.equal(out[0].type, 'text');
    assert.equal(out[0].text, 'look');
    assert.equal(out[1].type, 'image_url');
    assert.equal(out[1].image_url.url, 'https://x/y.png');
});

test('normalizeContentParts: non-part JSON array stays a raw string', () => {
    const s = '[1,2,3]';
    assert.equal(responses.normalizeContentParts(s), s);
});

test('normalizeContentParts: invalid JSON starting with [ stays a raw string', () => {
    const s = '[not json';
    assert.equal(responses.normalizeContentParts(s), s);
});

test('normalizeContentParts: string content is returned unchanged', () => {
    assert.equal(responses.normalizeContentParts('plain'), 'plain');
});

test('normalizeContentParts: null/undefined become an empty string', () => {
    assert.equal(responses.normalizeContentParts(null), '');
    assert.equal(responses.normalizeContentParts(undefined), '');
});

test('normalizeContentParts: non-array, non-string content is stringified', () => {
    assert.equal(responses.normalizeContentParts(42), '42');
});

test('normalizeContentParts: image_url given as a string url', () => {
    const out = responses.normalizeContentParts([{ type: 'image_url', image_url: 'https://a/b.png' }]);
    assert.ok(Array.isArray(out));
    assert.equal(out[0].type, 'image_url');
    assert.equal(out[0].image_url.url, 'https://a/b.png');
});

test('normalizeContentParts: image_url from a url field and detail passthrough', () => {
    const out = responses.normalizeContentParts([{ type: 'input_image', url: 'https://a/b.png', detail: 'high' }]);
    assert.equal(out[0].image_url.url, 'https://a/b.png');
    assert.equal(out[0].image_url.detail, 'high');
});

test('normalizeContentParts: images-only yields no text part', () => {
    const out = responses.normalizeContentParts([{ type: 'input_image', image_url: 'https://a/b.png' }]);
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'image_url');
});

test('normalizeContentParts: bare strings inside an array are joined as text', () => {
    assert.equal(responses.normalizeContentParts(['a', 'b']), 'a\nb');
});

test('normalizeContentParts: non-object entries inside an array are skipped', () => {
    assert.equal(responses.normalizeContentParts([null, 7, { text: 'ok' }]), 'ok');
});

// --- normalizeInput ---------------------------------------------------------

test('normalizeInput: undefined/null/string/non-array forms', () => {
    assert.deepEqual(responses.normalizeInput(undefined), []);
    assert.deepEqual(responses.normalizeInput(null), []);
    assert.deepEqual(responses.normalizeInput('hi'), [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(responses.normalizeInput(123), []);
});

test('normalizeInput: function_call becomes an assistant tool_calls message', () => {
    const out = responses.normalizeInput([{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }]);
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[0].content, null);
    assert.equal(out[0].tool_calls[0].id, 'c1');
    assert.equal(out[0].tool_calls[0].function.name, 'read');
});

test('normalizeInput: function_call with object arguments is stringified', () => {
    const out = responses.normalizeInput([{ type: 'function_call', name: 'x', arguments: { a: 1 } }]);
    assert.equal(out[0].tool_calls[0].function.arguments, '{"a":1}');
});

test('normalizeInput: function_call_output becomes a tool message', () => {
    const out = responses.normalizeInput([{ type: 'function_call_output', call_id: 'c1', output: 'ok' }]);
    assert.equal(out[0].role, 'tool');
    assert.equal(out[0].tool_call_id, 'c1');
    assert.equal(out[0].content, 'ok');
});

test('normalizeInput: reasoning items are dropped', () => {
    const out = responses.normalizeInput([{ type: 'reasoning' }, { role: 'user', content: 'hi' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'hi');
});

test('normalizeInput: untagged object with role falls back to a message', () => {
    const out = responses.normalizeInput([{ role: 'assistant', content: 'yo' }]);
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[0].content, 'yo');
});

test('normalizeInput: skips non-object entries', () => {
    assert.deepEqual(responses.normalizeInput([null, 5, 'x']), []);
});

// --- normalizeTools ---------------------------------------------------------

test('normalizeTools: flattens a flat function tool into nested shape', () => {
    const out = responses.normalizeTools([{ type: 'function', name: 'read', description: 'd', parameters: { type: 'object' } }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'function');
    assert.equal(out[0].function.name, 'read');
    assert.equal(out[0].function.description, 'd');
});

test('normalizeTools: already-nested tools pass through unchanged', () => {
    const tool = { type: 'function', function: { name: 'x' } };
    assert.deepEqual(responses.normalizeTools([tool]), [tool]);
});

test('normalizeTools: hosted/non-function tools are dropped', () => {
    assert.deepEqual(responses.normalizeTools([{ type: 'web_search' }]), []);
});

test('normalizeTools: invalid entries are dropped', () => {
    assert.deepEqual(responses.normalizeTools([null, 5, { type: 'function' }, { name: 7 }]), []);
});

test('normalizeTools: non-array input yields an empty array', () => {
    assert.deepEqual(responses.normalizeTools('x'), []);
    assert.deepEqual(responses.normalizeTools(undefined), []);
});

// --- parseResponsesRequest --------------------------------------------------

test('parseResponsesRequest: rejects a non-object JSON array', () => {
    assert.equal(responses.parseResponsesRequest('[]').ok, false);
});

test('parseResponsesRequest: accepts an empty body as an empty object', () => {
    const parsed = responses.parseResponsesRequest('');
    assert.equal(parsed.ok, true);
});
