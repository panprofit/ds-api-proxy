'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const prompt = require('../lib/prompt');
const config = require('../lib/config');

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
    assert.equal(prompt.normalizeMessageContent(content), '<tool_result>\ninner\n</tool_result>');
});

test('tool results: a literal </tool_result> is escaped so it cannot close the envelope', () => {
    const rendered = prompt.renderTurn({
        role: 'tool',
        content: 'before </tool_result> after',
        tool_call_id: 'c1',
    });
    assert.equal(rendered, '<tool_result>\nbefore <\\/tool_result> after\n</tool_result>\n\n');
    assert.equal(
        prompt.normalizeMessageContent([{ type: 'tool_result', content: 'x </TOOL_RESULT> y' }]),
        '<tool_result>\nx <\\/tool_result> y\n</tool_result>'
    );
});

test('tool results: oversized content is truncated on a UTF-8 boundary', () => {
    config.reload({ DS_MAX_TOOL_RESULT_BYTES: '4' });
    try {
        const rendered = prompt.renderTurn({ role: 'tool', content: 'ab😀cd' });

        assert.ok(rendered.includes('ab\n\n[tool result truncated: 8 bytes -> 2 bytes]'));
        assert.ok(!rendered.includes('\uFFFD'));
    } finally {
        config.reload({});
    }
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

test('formatToolDefinitions: renders the native DSML instruction and schemas', () => {
    const out = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
    }]);
    assert.ok(out.includes('### Available Tool Schemas'));
    assert.ok(out.includes('"name":"read"'));
    assert.ok(out.includes('"description":"Read a file"'));
    assert.ok(out.includes('"type":"object"'));
    assert.ok(out.includes('\uFF5CDSML\uFF5C calls'));
    assert.ok(out.includes('string="true|false"'));
    assert.ok(!out.includes('strict JSON'));
});

test('formatToolDefinitions: json format requests a plain <tool_call> JSON block', () => {
    const out = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'read', parameters: { type: 'object' } },
    }], 'auto', 'json');
    assert.ok(out.includes('<tool_call>\n{"name":"$TOOL_NAME","arguments":{"$PARAMETER_NAME":"$PARAMETER_VALUE"}}\n</tool_call>'));
    assert.ok(out.includes('REMEMBER: Request tools only inside a <tool_call> JSON block'));
    assert.ok(!out.includes('\uFF5CDSML\uFF5C'));
});

test('formatMessages: json format renders historical calls as JSON blocks', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: '{"path":"/x"}' } }] },
        { role: 'tool', content: 'ok' },
    ], [], null, 'auto', 'json');
    assert.ok(conversation.includes('<tool_call>\n{"name":"read","arguments":{"path":"/x"}}\n</tool_call>'));
    assert.ok(!conversation.includes('\uFF5CDSML\uFF5C'));
});

test('formatToolDefinitions: skips non-function entries', () => {
    assert.equal(prompt.formatToolDefinitions([{ type: 'other' }]), '');
    assert.equal(prompt.formatToolDefinitions([{ type: 'function', function: { description: 'no name' } }]), '');
});

test('formatToolDefinitions: emits the V4.1 leading-space DSML tag names', () => {
    const out = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'read' },
    }]);
    assert.ok(out.includes(`<${'\uFF5CDSML\uFF5C'} calls>`));
    assert.ok(out.includes(`<${'\uFF5CDSML\uFF5C'} invoke name="$TOOL_NAME">`));
    assert.ok(out.includes(`<${'\uFF5CDSML\uFF5C'} parameter name="$PARAMETER_NAME"`));
});

test('formatToolDefinitions: renders namespaced tools with a qualified name', () => {
    const out = prompt.formatToolDefinitions([{
        type: 'function',
        namespace: { name: 'search', description: 'Search tools.' },
        function: { name: 'lookup', description: 'Look up a value' },
    }]);
    assert.ok(out.includes('"name":"search::lookup"'));
    assert.ok(out.includes('Search tools.\\nLook up a value'));
});

test('formatToolDefinitions: accepts namespace inside function and qualified names', () => {
    const nested = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'lookup', namespace: 'search' },
    }]);
    assert.ok(nested.includes('"name":"search::lookup"'));
    const qualified = prompt.formatToolDefinitions([{
        type: 'function',
        function: { name: 'search::lookup' },
    }]);
    assert.ok(qualified.includes('"name":"search::lookup"'));
});

test('formatMessages: renders a namespaced assistant call with the qualified name', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', tool_calls: [{ namespace: 'search', function: { name: 'lookup', arguments: '{}' } }] },
    ], []);
    assert.ok(conversation.includes('invoke name="search::lookup"'));
});

test('formatToolDefinitions: tool_choice=none omits all tool instructions', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }];
    assert.equal(prompt.formatToolDefinitions(tools, 'none'), '');
});

test('formatToolDefinitions: required and named tool_choice add a mandatory instruction', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }];
    assert.ok(prompt.formatToolDefinitions(tools, 'required').includes('MUST invoke one of the available tools'));
    assert.ok(prompt.formatToolDefinitions(tools, { name: 'read' }).includes('MUST invoke the tool "read"'));
    assert.ok(!prompt.formatToolDefinitions(tools, 'auto').includes('MUST invoke'));
});

test('formatMessages: forwards tool_choice into the system prompt', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }];
    const { systemPrompt } = prompt.formatMessages([{ role: 'user', content: 'hi' }], tools, null, { name: 'read' });
    assert.ok(systemPrompt.includes('MUST invoke the tool "read"'));
    const none = prompt.formatMessages([{ role: 'user', content: 'hi' }], tools, null, 'none');
    assert.equal(none.systemPrompt.includes('### Available Tool Schemas'), false);
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

test('collectPendingTurns: two identical consecutive user turns are both pending', () => {
    const session = { sentKeys: new Set() };
    const messages = [
        { role: 'user', content: 'ping' },
        { role: 'user', content: 'ping' },
    ];
    const pending = prompt.collectPendingTurns(messages, session);
    assert.equal(pending.length, 2);
    prompt.markTurnsSent(session, pending);

    assert.equal(prompt.collectPendingTurns(messages, session).length, 0);
    assert.equal(prompt.collectPendingTurns([...messages, { role: 'user', content: 'ping' }], session).length, 1);
});

test('collectPendingTurns: identical tool results in different turns are both kept', () => {
    const session = { sentKeys: new Set() };
    const messages = [
        { role: 'tool', content: 'same', tool_call_id: 'a' },
        { role: 'tool', content: 'same', tool_call_id: 'b' },
    ];
    assert.equal(prompt.collectPendingTurns(messages, session).length, 2);
});

test('markTurnsSent: a subset marks the same occurrence keys as the full list', () => {

    const session = { sentKeys: new Set() };
    const first = { role: 'user', content: 'dup' };
    const second = { role: 'user', content: 'dup' };
    const messages = [first, second];

    prompt.markTurnsSent(session, [first]);
    const pending = prompt.collectPendingTurns(messages, session);
    assert.deepEqual(pending, [second]);
    prompt.markTurnsSent(session, pending);
    assert.equal(prompt.collectPendingTurns(messages, session).length, 0);
});

test('formatPendingTurns: renders user and tool turns', () => {
    const out = prompt.formatPendingTurns([
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'res', tool_call_id: 'c1' },
    ]);
    assert.ok(out.includes('User: hello'));
    assert.ok(out.includes('<tool_result>\nres\n</tool_result>'));
});

test('renderTurn: renders a user turn, a tool turn and nothing else', () => {
    assert.equal(prompt.renderTurn({ role: 'user', content: 'hello' }), 'User: hello\n\n');
    assert.equal(prompt.renderTurn({ role: 'tool', content: 'res', tool_call_id: 'c1' }), '<tool_result>\nres\n</tool_result>\n\n');
    assert.equal(prompt.renderTurn({ role: 'tool', content: 'res' }), '<tool_result>\nres\n</tool_result>\n\n');
    assert.equal(prompt.renderTurn({ role: 'assistant', content: 'x' }), '');
    assert.equal(prompt.renderTurn({ role: 'user', content: '' }), '');
    assert.equal(prompt.renderTurn(null), '');
});

test('formatMessages: renders tool results through the shared renderTurn path', () => {

    config.reload({ DS_MAX_RESPONSE_WORDS: '0' });
    try {
        const msg = { role: 'tool', content: 'out', tool_call_id: 'c9' };
        const { prompt: conversation } = prompt.formatMessages([msg], []);
        assert.equal(conversation, prompt.formatPendingTurns([msg]));
        assert.equal(conversation, '<tool_result>\nout\n</tool_result>');
    } finally {
        config.reload({});
    }
});

test('formatMessages: separates system prompt and conversation', () => {

    config.reload({ DS_MAX_RESPONSE_WORDS: '0' });
    try {
        const { prompt: conversation, systemPrompt } = prompt.formatMessages([
            { role: 'system', content: 'be nice' },
            { role: 'user', content: 'hi' },
        ], []);
        assert.equal(systemPrompt, 'be nice');
        assert.equal(conversation, 'User: hi');
    } finally {
        config.reload({});
    }
});

test('formatMessages: keeps mid-conversation system messages in place', () => {
    config.reload({ DS_MAX_RESPONSE_WORDS: '0' });
    try {
        const { prompt: conversation, systemPrompt } = prompt.formatMessages([
            { role: 'system', content: 'lead' },
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'a1' },
            { role: 'system', content: 'reminder' },
            { role: 'user', content: 'u2' },
        ], []);
        assert.equal(systemPrompt, 'lead');
        assert.equal(conversation.includes('lead'), false);
        assert.equal(
            conversation,
            'User: u1\n\nAssistant: a1\n\nSystem: reminder\n\nUser: u2'
        );
    } finally {
        config.reload({});
    }
});

test('collectPendingTurns: forwards a mid-conversation system message, not the leading one', () => {
    const session = { sentKeys: new Set() };
    const leading = { role: 'system', content: 'lead' };
    const mid = { role: 'system', content: 'reminder' };
    const messages = [leading, { role: 'user', content: 'u1' }, mid, { role: 'user', content: 'u2' }];
    assert.deepEqual(
        prompt.collectPendingTurns(messages, session),
        [messages[1], mid, messages[3]]
    );
    prompt.markTurnsSent(session, messages);
    assert.equal(session.sentKeys.size, 3);
    assert.deepEqual(prompt.collectPendingTurns(messages, session), []);
});

test('formatMessages: renders assistant tool_calls as native DSML invokes', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'user', content: 'go' },
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
    ], []);
    assert.ok(conversation.includes('invoke name="read"'));
    assert.ok(conversation.includes('parameter name="path" string="true">a</'));
    assert.ok(conversation.includes('\uFF5CDSML\uFF5C calls>'));
});

test('formatMessages: never folds assistant reasoning into the prompt', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', reasoning_content: 'weigh options', content: 'done' },
    ], []);
    assert.equal(conversation, 'Assistant: done');
    assert.ok(!conversation.includes('<think>'));
});

test('formatMessages: reasoning is dropped even when tools are declared', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', reasoning_content: 'old think', content: 'old answer' },
        { role: 'user', content: 'next question' },
        { role: 'assistant', reasoning_content: 'current think', content: 'current answer' },
    ], [{ type: 'function', function: { name: 'read' } }]);
    assert.ok(!conversation.includes('old think'));
    assert.ok(!conversation.includes('current think'));
    assert.ok(conversation.includes('old answer'));
    assert.ok(conversation.includes('current answer'));
});

test('formatMessages: reasoning is dropped next to a tool call', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'user', content: 'do it' },
        { role: 'assistant', reasoning_content: 'need the file', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a"}' } }] },
        { role: 'tool', content: 'result' },
        { role: 'assistant', reasoning_content: 'after tool', content: 'final' },
    ], []);
    assert.ok(!conversation.includes('need the file'));
    assert.ok(!conversation.includes('after tool'));
    assert.ok(!conversation.includes('<think>'));
    assert.ok(conversation.includes('invoke name="read"'));
    assert.ok(conversation.includes('final'));
});

test('formatMessages: non-string arguments are JSON-encoded with string="false"', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: { n: 1, ok: true } } }] },
    ], []);
    assert.ok(conversation.includes('parameter name="n" string="false">1</'));
    assert.ok(conversation.includes('parameter name="ok" string="false">true</'));
});

test('formatMessages: unparseable arguments fall back to a raw arguments parameter', () => {
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: 'not json' } }] },
    ], []);
    assert.ok(conversation.includes('parameter name="arguments" string="true">not json</'));
});

test('formatMessages: includes tool definitions in the system prompt', () => {
    const { systemPrompt } = prompt.formatMessages([], [
        { type: 'function', function: { name: 'read', description: 'Read' } },
    ]);
    assert.ok(systemPrompt.includes('"name":"read"'));
    assert.ok(systemPrompt.includes('### Available Tool Schemas'));
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

test('collectPendingTurns: after marking a fresh session, nothing is pending', () => {
    const messages = [
        { role: 'system', content: 's' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'look' }] },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'result' },
    ];
    const session = { sentKeys: new Set() };

    prompt.markTurnsSent(session, messages);
    assert.deepEqual(prompt.collectPendingTurns(messages, session), []);
});

test('formatResponseFormat: json_object uses the V4.1 response-format block', () => {
    assert.equal(
        prompt.formatResponseFormat({ type: 'json_object' }),
        '## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n{"type": "json_object"}',
    );
});

test('formatResponseFormat: json_schema renders only the schema, not the wrapper', () => {
    const out = prompt.formatResponseFormat({
        type: 'json_schema',
        json_schema: { name: 'person', strict: true, schema: { type: 'object' } },
    });
    assert.ok(out.startsWith('## Response Format:'));
    assert.ok(out.endsWith('{"type":"object"}'));
    assert.ok(!out.includes('"strict"'));
});

test('formatResponseFormat: json_schema without a schema still asks for JSON', () => {
    const out = prompt.formatResponseFormat({ type: 'json_schema' });
    assert.ok(out.includes('JSON'));
});

test('formatResponseFormat: text / unknown / nullish -> empty', () => {
    assert.equal(prompt.formatResponseFormat({ type: 'text' }), '');
    assert.equal(prompt.formatResponseFormat(null), '');
    assert.equal(prompt.formatResponseFormat(undefined), '');
    assert.equal(prompt.formatResponseFormat({}), '');
});

test('formatMessages: folds response_format into the system prompt', () => {
    const { systemPrompt } = prompt.formatMessages(
        [{ role: 'user', content: 'hi' }], [], { type: 'json_object' });
    assert.ok(systemPrompt.includes('## Response Format:'));
    assert.ok(systemPrompt.includes('{"type": "json_object"}'));
});

test('formatMessages: prepends the V4.1 reasoning-effort line', () => {
    const { systemPrompt } = prompt.formatMessages(
        [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], [], null, 'auto', 'dsml', 75);
    assert.ok(systemPrompt.startsWith(
        'Reasoning Effort: 75 (range 1-100, the higher the value, the more thorough the reasoning)\n\nsys',
    ));
});

test('formatMessages: omits the reasoning-effort line when the score is null', () => {
    const { systemPrompt } = prompt.formatMessages(
        [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], []);
    assert.ok(!systemPrompt.includes('Reasoning Effort:'));
});

test('formatMessages: no response_format leaves the system prompt free-form', () => {
    const { systemPrompt } = prompt.formatMessages([{ role: 'user', content: 'hi' }], []);
    assert.ok(!systemPrompt.includes('~~~json'));
});

test('formatResponseLengthLimit: renders the word cap as an instruction', () => {
    const out = prompt.formatResponseLengthLimit(500);
    assert.ok(out.includes('500'));
});

test('formatResponseLengthLimit: 0 / negative / nullish -> empty', () => {
    assert.equal(prompt.formatResponseLengthLimit(0), '');
    assert.equal(prompt.formatResponseLengthLimit(-5), '');
    assert.equal(prompt.formatResponseLengthLimit(null), '');
    assert.equal(prompt.formatResponseLengthLimit(undefined), '');
    assert.equal(prompt.formatResponseLengthLimit(NaN), '');
});

test('formatMessages: folds the configured word cap into the system prompt', () => {
    config.reload({ DS_MAX_RESPONSE_WORDS: '250' });
    try {
        const { systemPrompt } = prompt.formatMessages([{ role: 'user', content: 'hi' }], []);
        assert.ok(systemPrompt.includes('250'));
    } finally {
        config.reload({});
    }
});

test('formatMessages: DS_MAX_RESPONSE_WORDS=0 omits the word cap', () => {
    config.reload({ DS_MAX_RESPONSE_WORDS: '0' });
    try {
        const { systemPrompt } = prompt.formatMessages([{ role: 'user', content: 'hi' }], []);
        assert.equal(systemPrompt, '');
    } finally {
        config.reload({});
    }
});

test('round-trip: prompt-rendered markup parses back into the same tool call', () => {
    const parser = require('../lib/parser');
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a","n":2}' } }] },
    ], []);
    const call = parser.parseToolCall(conversation, () => {});
    assert.ok(call);
    assert.equal(call.name, 'read');
    assert.deepEqual(JSON.parse(call.arguments), { path: 'a', n: 2 });
});

test('round-trip: prompt-rendered markup escapes XML-unsafe argument values', () => {
    const parser = require('../lib/parser');
    const { prompt: conversation } = prompt.formatMessages([
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"echo a && echo <b>"}' } }] },
    ], []);
    const call = parser.parseToolCall(conversation, () => {});
    assert.ok(call);
    assert.equal(call.name, 'bash');
    assert.deepEqual(JSON.parse(call.arguments), { command: 'echo a && echo <b>' });
});

test('round-trip: a rendered tool result is recognized as a harness envelope', () => {
    const { isToolResultEcho } = require('../lib/recovery-classify');
    const rendered = prompt.renderTurn({ role: 'tool', content: 'out', tool_call_id: 'c1' });
    assert.equal(isToolResultEcho(rendered), true);
    assert.equal(isToolResultEcho(rendered.trimEnd()), true);
});
