'use strict';
// Unit tests for lib/prompt.js (message normalization, prompt building,
// incremental-turn bookkeeping, screenshot extraction).

const test = require('node:test');
const assert = require('node:assert/strict');

const prompt = require('../lib/prompt');

test('normalizeMessageContent: strings pass through, nullish -> empty', () => {
    assert.equal(prompt.normalizeMessageContent('hi'), 'hi');
    assert.equal(prompt.normalizeMessageContent(null), '');
    assert.equal(prompt.normalizeMessageContent(undefined), '');
});

test('normalizeMessageContent: joins text parts and skips images', () => {
    const content = [
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'data:' } },
        { type: 'input_text', text: 'b' },
        { type: 'output_text', text: 'c' },
    ];
    assert.equal(prompt.normalizeMessageContent(content), 'a\nb\nc');
});

test('normalizeMessageContent: renders tool_result parts recursively', () => {
    const content = [{ type: 'tool_result', tool_use_id: 't1', content: 'inner' }];
    assert.equal(prompt.normalizeMessageContent(content), '[Tool Result t1]\ninner');
});

test('composePrompt: joins system + conversation, trims, omits empty system', () => {
    assert.equal(prompt.composePrompt('sys', 'conv'), 'sys\n\nconv');
    assert.equal(prompt.composePrompt('', 'conv'), 'conv');
    assert.equal(prompt.composePrompt(null, 'conv'), 'conv');
    assert.equal(prompt.composePrompt('  sys  ', '  conv  '), 'sys\n\nconv');
});

test('appendPromptInstruction: appends a blank-line-separated suffix', () => {
    assert.equal(prompt.appendPromptInstruction('body', 'go'), 'body\n\ngo');
});

test('formatToolDefinitions: empty tools -> empty string', () => {
    assert.equal(prompt.formatToolDefinitions([]), '');
    assert.equal(prompt.formatToolDefinitions(null), '');
});

test('formatToolDefinitions: renders name, description and parameters', () => {
    const out = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
    }]);
    assert.ok(out.includes('## read'));
    assert.ok(out.includes('Read a file'));
    assert.ok(out.includes('"type":"object"'));
    assert.ok(out.includes('--- END TOOL REQUEST SYSTEM ---'));
});

test('formatToolDefinitions: truncates long descriptions', () => {
    const out = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'x', description: 'y'.repeat(600) },
    }]);
    assert.ok(out.includes('...'));
});

test('messageFingerprint: stable for identical content, differs by role', () => {
    assert.equal(prompt.messageFingerprint({ role: 'user', content: 'x' }), 'user\u0000x');
    assert.notEqual(
        prompt.messageFingerprint({ role: 'user', content: 'x' }),
        prompt.messageFingerprint({ role: 'tool', content: 'x' })
    );
});

test('collectPendingTurns: skips system, empty and already-sent turns', () => {
    const session = { sentKeys: new Set() };
    const messages = [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a' },
        { role: 'tool', content: 't1', tool_call_id: 'x' },
        { role: 'user', content: '' },
    ];
    const pending = prompt.collectPendingTurns(messages, session);
    assert.deepEqual(pending.map(m => m.content), ['u1', 't1']);
});

test('collectPendingTurns: repairs a non-Set sentKeys', () => {
    const session = { sentKeys: null };
    prompt.collectPendingTurns([{ role: 'user', content: 'u' }], session);
    assert.ok(session.sentKeys instanceof Set);
});

test('markTurnsSent: marks user/tool turns and excludes them next time', () => {
    const session = { sentKeys: new Set() };
    const turns = [{ role: 'user', content: 'u1' }, { role: 'tool', content: 't1' }];
    prompt.markTurnsSent(session, turns);
    assert.equal(session.sentKeys.size, 2);
    assert.deepEqual(prompt.collectPendingTurns(turns, session), []);
});

test('formatPendingTurns: renders user and tool turns', () => {
    const out = prompt.formatPendingTurns([
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'res', tool_call_id: 'c1' },
    ]);
    assert.ok(out.includes('User: hello'));
    assert.ok(out.includes('[Tool Result id=c1]'));
});

test('formatMessages: separates system prompt and conversation', () => {
    const { prompt: conversation, systemPrompt } = prompt.formatMessages([
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
    ], []);
    assert.equal(systemPrompt, 'be nice');
    assert.equal(conversation, 'User: hi');
});

test('formatMessages: renders assistant tool_calls as strict JSON', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    ], []);
    assert.ok(conversation.includes('"name":"read"'));
    assert.ok(conversation.includes('"arguments":{"path":"a"}'));
});

test('formatMessages: includes tool definitions in the system prompt', () => {
    const { systemPrompt } = prompt.formatMessages([], [
        { type: 'function', function: { name: 'read', description: 'Read' } },
    ]);
    assert.ok(systemPrompt.includes('## read'));
});

test('extractScreenshotPaths: collects structured screenshot_path JSON fields', () => {
    const exists = (p) => p === '/tmp/a.png';
    const messages = [{ role: 'tool', content: '{"screenshot_path":"/tmp/a.png"}' }];
    assert.deepEqual(prompt.extractScreenshotPaths(messages, exists), ['MEDIA:/tmp/a.png']);
});

test('extractScreenshotPaths: collects `path` field and nested `media` arrays', () => {
    const exists = (p) => p === '/tmp/a.png' || p === '/tmp/b.jpg';
    const messages = [
        { role: 'tool', content: { path: '/tmp/a.png' } },
        { role: 'tool', content: '{"media":["/tmp/b.jpg","/tmp/nope.png"]}' },
    ];
    assert.deepEqual(prompt.extractScreenshotPaths(messages, exists), ['MEDIA:/tmp/a.png', 'MEDIA:/tmp/b.jpg']);
});

test('extractScreenshotPaths: ignores non-existent files and dedupes', () => {
    assert.deepEqual(prompt.extractScreenshotPaths([{ role: 'tool', content: '{"path":"/x.png"}' }], () => false), []);
    const dup = [{ role: 'tool', content: '{"media":["/x.png","/x.png"]}' }];
    assert.deepEqual(prompt.extractScreenshotPaths(dup, () => true), ['MEDIA:/x.png']);
});

test('extractScreenshotPaths: ignores free text (prompt-injection guard)', () => {
    const exists = () => true;
    // MEDIA: tags in tool text, absolute image paths in user/assistant text,
    // and image URLs in non-image JSON fields must all be ignored now.
    const messages = [
        { role: 'tool', content: 'see MEDIA:/etc/passwd.png here' },
        { role: 'user', content: 'look at /tmp/pic.jpg now' },
        { role: 'assistant', content: 'and /tmp/other.png' },
        { role: 'tool', content: '{"url":"/tmp/evil.png"}' },
    ];
    assert.deepEqual(prompt.extractScreenshotPaths(messages, exists), []);
});

test('extractScreenshotPaths: ignores non-image extensions', () => {
    const exists = () => true;
    const messages = [{ role: 'tool', content: '{"path":"/tmp/notes.txt"}' }];
    assert.deepEqual(prompt.extractScreenshotPaths(messages, exists), []);
});

// --- markTurnsSent on a fresh session ---------------------------------------

test('collectPendingTurns: after marking a fresh session, nothing is pending', () => {
    const messages = [
        { role: 'system', content: 's' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'look' }] },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'result' },
    ];
    const session = { sentKeys: new Set() };
    // Fresh session: the whole history was forwarded, so mark all of it.
    // markTurnsSent ignores non user/tool roles; collectPendingTurns must then
    // report nothing as pending (this is what stops image re-attachment).
    prompt.markTurnsSent(session, messages);
    assert.deepEqual(prompt.collectPendingTurns(messages, session), []);
});
