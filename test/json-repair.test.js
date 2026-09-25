'use strict';
// Direct unit tests for lib/json-repair.js: balanced-JSON extraction, the
// repair heuristics and the candidate -> tool-call coercion. These previously
// had no dedicated file (only indirect coverage via parser.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const jr = require('../lib/json-repair');
const { MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_JSON_CANDIDATES } = require('../lib/parser-limits');

// --- extractBalancedJsonAt -------------------------------------------------

test('extractBalancedJsonAt: returns the balanced object at the index', () => {
    const text = 'xx{"a":1}yy';
    assert.equal(jr.extractBalancedJsonAt(text, 2), '{"a":1}');
});

test('extractBalancedJsonAt: null when the char is not an opening brace', () => {
    assert.equal(jr.extractBalancedJsonAt('x{a:1}', 0), null);
});

test('extractBalancedJsonAt: null when the object never closes', () => {
    assert.equal(jr.extractBalancedJsonAt('{"a":1', 0), null);
});

test('extractBalancedJsonAt: braces inside strings do not affect the match', () => {
    const text = '{"a":"}{","b":2}';
    assert.equal(jr.extractBalancedJsonAt(text, 0), text);
});

// --- extractBalancedJsonObjects --------------------------------------------

test('extractBalancedJsonObjects: finds multiple objects in order', () => {
    assert.deepEqual(jr.extractBalancedJsonObjects('{"a":1} and {"b":2}'), ['{"a":1}', '{"b":2}']);
});

test('extractBalancedJsonObjects: a stray unclosed opener is skipped', () => {
    // A leading `{sh ...` must not discard a later valid object.
    const out = jr.extractBalancedJsonObjects('{sh ... then {"ok":true}');
    assert.deepEqual(out, ['{"ok":true}']);
});

test('extractBalancedJsonObjects: honours the maxObjects cap', () => {
    const many = Array.from({ length: 5 }, (_, i) => `{"i":${i}}`).join(' ');
    assert.equal(jr.extractBalancedJsonObjects(many, 3).length, 3);
    assert.equal(jr.extractBalancedJsonObjects(many, MAX_TOOL_JSON_CANDIDATES).length, 5);
});

test('extractBalancedJsonObjects: empty string yields no objects', () => {
    assert.deepEqual(jr.extractBalancedJsonObjects(''), []);
});

// --- repairJsonText --------------------------------------------------------

test('repairJsonText: escapes raw control characters inside strings', () => {
    const broken = '{"a":"line1\nline2"}';
    const out = jr.repairJsonText(broken);
    assert.equal(JSON.parse(out).a, 'line1\nline2');
});

test('repairJsonText: drops a trailing comma before a closer', () => {
    const out = jr.repairJsonText('{"a":1,}');
    assert.deepEqual(JSON.parse(out), { a: 1 });
});

test('repairJsonText: a comma inside a string is preserved', () => {
    const out = jr.repairJsonText('{"a":"x,}"}');
    assert.equal(JSON.parse(out).a, 'x,}');
});

test('repairJsonText: returns the input unchanged when nothing applies', () => {
    const ok = '{"a":1}';
    assert.equal(jr.repairJsonText(ok), ok);
    assert.equal(jr.repairJsonText(''), '');
});

// --- repairUnescapedQuotes -------------------------------------------------

test('repairUnescapedQuotes: escapes a data quote inside a value', () => {
    const broken = '{"tool_call":{"name":"bash","arguments":{"command":"echo "hi""}}}';
    const out = jr.repairUnescapedQuotes(broken);
    assert.equal(JSON.parse(out).tool_call.arguments.command, 'echo "hi"');
});

test('repairUnescapedQuotes: leaves already-valid JSON unchanged', () => {
    const ok = '{"a":"b"}';
    assert.equal(jr.repairUnescapedQuotes(ok), ok);
});

// --- repairXmlLikeKeys -----------------------------------------------------

test('repairXmlLikeKeys: turns attr syntax into JSON members', () => {
    const out = jr.repairXmlLikeKeys('{ id="call_1"}');
    assert.equal(out, '{ "id":"call_1"}');
});

test('repairXmlLikeKeys: inserts the missing comma between glued literals', () => {
    const out = jr.repairXmlLikeKeys('{"id":"call_1""name":"read"}');
    assert.equal(JSON.parse(out).name, 'read');
});

test('repairXmlLikeKeys: unchanged when no attribute syntax is present', () => {
    const ok = '{"a":1}';
    assert.equal(jr.repairXmlLikeKeys(ok), ok);
});

// --- repairStrayClosingQuote -----------------------------------------------

test('repairStrayClosingQuote: drops a stray quote before the closers', () => {
    const broken = '{"tool_call":{"name":"read","arguments":{"limit":35"}}}';
    const out = jr.repairStrayClosingQuote(broken);
    assert.deepEqual(JSON.parse(out).tool_call.arguments, { limit: 35 });
});

test('repairStrayClosingQuote: ignores text without a tool-call shape', () => {
    const prose = 'hello 35"} world';
    assert.equal(jr.repairStrayClosingQuote(prose), prose);
});

// --- repairNestedStringValue -----------------------------------------------

test('repairNestedStringValue: re-escapes a nested body with raw quotes', () => {
    const broken = '{"tool_call":{"name":"bash","arguments":{"command":"node -e ' +
        "'\nconsole.log(\"hi\");\n" + "'" + '"}}}';
    const out = jr.repairNestedStringValue(broken);
    const parsed = JSON.parse(out);
    assert.equal(parsed.tool_call.name, 'bash');
    assert.match(parsed.tool_call.arguments.command, /console\.log/);
});

test('repairNestedStringValue: leaves a valid nested object alone', () => {
    const ok = '{"tool_call":{"name":"bash","arguments":{"command":"echo hi"}}}';
    assert.equal(jr.repairNestedStringValue(ok), ok);
});

// --- completeJsonClosers ---------------------------------------------------

test('completeJsonClosers: appends the missing closers', () => {
    assert.equal(jr.completeJsonClosers('{"a":{"b":1}'), '{"a":{"b":1}}');
    assert.equal(jr.completeJsonClosers('{"a":[1,2'), '{"a":[1,2]}');
});

test('completeJsonClosers: null when not a plausible truncated body', () => {
    assert.equal(jr.completeJsonClosers('not json'), null);
    assert.equal(jr.completeJsonClosers('{"a":1}'), null, 'already balanced');
    assert.equal(jr.completeJsonClosers('{"a":'), null, 'ends mid-token');
    assert.equal(jr.completeJsonClosers('{"a":"open'), null, 'ends inside a string');
});

// --- splitConcatenatedToolCalls --------------------------------------------

test('splitConcatenatedToolCalls: splits two glued calls into a comma-joined pair', () => {
    const a = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
    const b = '{"tool_call":{"name":"bash","arguments":{"command":"ls"}}}';
    const out = jr.splitConcatenatedToolCalls(a + b);
    // Repaired output is a comma-joined sequence of balanced objects.
    const objs = jr.extractBalancedJsonObjects(out);
    assert.equal(objs.length, 2);
});

test('splitConcatenatedToolCalls: a single call is returned unchanged', () => {
    const one = '{"tool_call":{"name":"read","arguments":{}}}';
    assert.equal(jr.splitConcatenatedToolCalls(one), one);
});

// --- buildToolCall ---------------------------------------------------------

test('buildToolCall: serializes object arguments', () => {
    const tc = jr.buildToolCall('read', { path: '/x' });
    assert.deepEqual(tc, { name: 'read', arguments: '{"path":"/x"}' });
});

test('buildToolCall: parses string arguments', () => {
    assert.deepEqual(jr.buildToolCall('read', '{"path":"/x"}'), { name: 'read', arguments: '{"path":"/x"}' });
});

test('buildToolCall: rejects invalid names and non-object args', () => {
    assert.equal(jr.buildToolCall('bad name', {}), null);
    assert.equal(jr.buildToolCall('', {}), null);
    assert.equal(jr.buildToolCall('read', [1, 2]), null);
    assert.equal(jr.buildToolCall('read', 'not json'), null);
});

test('buildToolCall: rejects arguments beyond the size cap', () => {
    const big = 'x'.repeat(MAX_TOOL_ARGUMENT_CHARS + 1);
    assert.equal(jr.buildToolCall('bash', { command: big }), null);
});

test('buildToolCall: null/undefined arguments become an empty object', () => {
    assert.deepEqual(jr.buildToolCall('read', null), { name: 'read', arguments: '{}' });
});

// --- coerceToolCallObject --------------------------------------------------

test('coerceToolCallObject: unwraps tool_call / function_call / tool_calls[]', () => {
    assert.equal(jr.coerceToolCallObject({ tool_call: { name: 'a', arguments: {} } }).name, 'a');
    assert.equal(jr.coerceToolCallObject({ function_call: { name: 'b', arguments: {} } }).name, 'b');
    assert.equal(jr.coerceToolCallObject({ tool_calls: [{ function: { name: 'c', arguments: {} } }] }).name, 'c');
});

test('coerceToolCallObject: tool_calls must hold exactly one entry', () => {
    assert.equal(jr.coerceToolCallObject({ tool_calls: [] }), null);
    assert.equal(jr.coerceToolCallObject({ tool_calls: [{ name: 'a' }, { name: 'b' }] }), null);
});

test('coerceToolCallObject: bare objects only when allowBare', () => {
    assert.equal(jr.coerceToolCallObject({ name: 'a', arguments: {} }), null);
    assert.equal(jr.coerceToolCallObject({ name: 'a', arguments: {} }, { allowBare: true }).name, 'a');
});

// --- parseJsonToolCandidate + diagnostics ----------------------------------

test('parseJsonToolCandidate: parses a direct call and clears the error slot', () => {
    jr.resetJsonParseError();
    const tc = jr.parseJsonToolCandidate('{"tool_call":{"name":"read","arguments":{"p":1}}}', 't', {}, () => {});
    assert.equal(tc.name, 'read');
    assert.equal(jr.takeJsonParseError(), null, 'successful parse clears the recorded error');
});

test('parseJsonToolCandidate: repairs a trailing comma and succeeds', () => {
    const tc = jr.parseJsonToolCandidate('{"tool_call":{"name":"read","arguments":{"p":1,}}}', 't', {}, () => {});
    assert.equal(tc.name, 'read');
});

test('parseJsonToolCandidate: records a JSON error on failure, takeJsonParseError clears it', () => {
    jr.resetJsonParseError();
    const tc = jr.parseJsonToolCandidate('{"tool_call":{"name":"read","arguments":{"p":}}', 't', {}, () => {});
    assert.equal(tc, null);
    const err = jr.takeJsonParseError();
    assert.ok(err && typeof err === 'string');
    assert.equal(jr.takeJsonParseError(), null, 'take clears the slot');
});

test('parseJsonToolCandidate: empty input returns null without touching the slot', () => {
    jr.resetJsonParseError();
    assert.equal(jr.parseJsonToolCandidate('', 't', {}, () => {}), null);
    assert.equal(jr.takeJsonParseError(), null);
});
