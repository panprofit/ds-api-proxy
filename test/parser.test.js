// parser.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../lib/parser.js');

const silentLog = () => {};

// ---------------------------------------------------------------------------
// extractBalancedJsonAt
// ---------------------------------------------------------------------------
test('extractBalancedJsonAt: simple object', () => {
  const text = 'prefix {"a":1} suffix';
  assert.equal(parser.extractBalancedJsonAt(text, text.indexOf('{')), '{"a":1}');
});

test('extractBalancedJsonAt: nested objects', () => {
  const text = '{"a":{"b":{"c":1}}}';
  assert.equal(parser.extractBalancedJsonAt(text, 0), text);
});

test('extractBalancedJsonAt: braces inside strings are ignored', () => {
  const text = '{"a":"}{}{","b":1}';
  assert.equal(parser.extractBalancedJsonAt(text, 0), text);
});

test('extractBalancedJsonAt: escaped quotes', () => {
  const text = '{"a":"\\"}{\\""}';
  assert.equal(parser.extractBalancedJsonAt(text, 0), text);
});

test('extractBalancedJsonAt: unclosed object -> null', () => {
  const text = '{"a":1';
  assert.equal(parser.extractBalancedJsonAt(text, 0), null);
});

test('extractBalancedJsonAt: does not start with { -> null', () => {
  assert.equal(parser.extractBalancedJsonAt('abc', 0), null);
});

// ---------------------------------------------------------------------------
// extractBalancedJsonObjects
// ---------------------------------------------------------------------------
test('extractBalancedJsonObjects: several objects', () => {
  const text = 'x {"a":1} y {"b":2} z';
  assert.deepEqual(parser.extractBalancedJsonObjects(text), ['{"a":1}', '{"b":2}']);
});

test('extractBalancedJsonObjects: nesting', () => {
  const text = '{"a":{"b":1}} {"c":2}';
  assert.deepEqual(parser.extractBalancedJsonObjects(text), ['{"a":{"b":1}}', '{"c":2}']);
});

test('extractBalancedJsonObjects: honors maxObjects', () => {
  const text = '{"a":1}{"b":2}{"c":3}';
  assert.deepEqual(parser.extractBalancedJsonObjects(text, 2), ['{"a":1}', '{"b":2}']);
});

test('extractBalancedJsonObjects: garbage without objects', () => {
  assert.deepEqual(parser.extractBalancedJsonObjects('no json here'), []);
});

// Regression: a stray, never-closing `{` earlier in the text (e.g. the model
// writing prose like `{sh ...`) used to abort the whole scan, discarding a
// later valid tool call. Seen in production dumps as long `No tool call match`
// messages whose real call sat after the unbalanced brace.
test('extractBalancedJsonObjects: unclosed object before a valid one does not abort the scan', () => {
  const good = '{"tool_call":{"name":"bash","arguments":{"command":"echo hi"}}}';
  const text = `Example {sh\n# comment\n${good}`;
  assert.deepEqual(parser.extractBalancedJsonObjects(text), [good]);
  const tc = parser.parseToolCall(text, () => {});
  assert.ok(tc, 'a valid call after an unbalanced brace must still parse');
  assert.equal(tc.name, 'bash');
});

test('extractBalancedJsonObjects: several unclosed braces before a valid one', () => {
  const good = '{"a":1}';
  const text = `prose { and {more { no closers ${good}`;
  assert.deepEqual(parser.extractBalancedJsonObjects(text), [good]);
});

// Regression: the scanner used to desync inString on an escaped quote
// inside a nested JSON-in-a-string, so a balanced object was never found and
// the markup was falsely considered "unclosed".
test('extractBalancedJsonObjects: escaped quotes inside a string', () => {
  const text = '{"tool_call":{"name":"bash","arguments":{"command":"echo \\"hi\\""}}}';
  const objs = parser.extractBalancedJsonObjects(text);
  assert.equal(objs.length, 1);
  assert.doesNotThrow(() => JSON.parse(objs[0]));
});

test('extractBalancedJsonObjects: escaped backslash inside a string', () => {
  // "a\\\\b" -> the string contains the literal \\; brace matching must not desync.
  const text = '{"s":"a\\\\b","n":1}';
  assert.deepEqual(parser.extractBalancedJsonObjects(text), [text]);
  assert.doesNotThrow(() => JSON.parse(text));
});

test('findJsonObjectEnd: no closing brace found -> -1', () => {
  assert.equal(parser.extractBalancedJsonAt('{"a":', 0), null);
  assert.equal(parser.extractBalancedJsonAt('{"a":1}', 0), '{"a":1}');
});

// ---------------------------------------------------------------------------
// parse diagnostics
// ---------------------------------------------------------------------------
test('takeJsonParseError: returns the reason for the last JSON.parse error', () => {
  // Brace-balanced candidate whose inner value is not valid JSON, so
  // JSON.parse is attempted and throws. (A truncated candidate with no
  // closing brace never reaches JSON.parse, so no error is recorded.)
  parser.parseToolCall('{"tool_call":{"name":"edit","arguments":{"path":/x}}}', () => {});
  const err = parser.takeJsonParseError();
  assert.ok(err && typeof err === 'string', 'expected an error string');
  // the second call clears the slot
  assert.equal(parser.takeJsonParseError(), null);
});

test('takeJsonParseError: null after a successful parse', () => {
  const tc = parser.parseToolCall('{"tool_call":{"name":"edit","arguments":{"path":"/x"}}}', () => {});
  assert.ok(tc);
  assert.equal(parser.takeJsonParseError(), null);
});

// ---------------------------------------------------------------------------
// buildToolCall
// ---------------------------------------------------------------------------
test('buildToolCall: normal call', () => {
  const tc = parser.buildToolCall('get_weather', { city: 'Moscow' });
  assert.equal(tc.name, 'get_weather');
  assert.equal(tc.arguments, '{"city":"Moscow"}');
});

test('buildToolCall: arguments as a JSON string', () => {
  const tc = parser.buildToolCall('f', '{"x":1}');
  assert.deepEqual(JSON.parse(tc.arguments), { x: 1 });
});

test('buildToolCall: empty/undefined arguments -> {}', () => {
  assert.equal(parser.buildToolCall('f').arguments, '{}');
  assert.equal(parser.buildToolCall('f', null).arguments, '{}');
});

test('buildToolCall: invalid name -> null', () => {
  assert.equal(parser.buildToolCall('', {}), null);
  assert.equal(parser.buildToolCall(' bad name', {}), null);
  assert.equal(parser.buildToolCall('a'.repeat(129), {}), null);
});

test('buildToolCall: name with allowed special chars', () => {
  assert.ok(parser.buildToolCall('a.b:c-d_e', {}));
});

test('buildToolCall: array as arguments -> null', () => {
  assert.equal(parser.buildToolCall('f', [1, 2]), null);
});

test('buildToolCall: invalid JSON argument string -> null', () => {
  assert.equal(parser.buildToolCall('f', '{not json}'), null);
});

test('buildToolCall: overly large arguments -> null', () => {
  const big = { a: 'x'.repeat(parser.MAX_TOOL_ARGUMENT_CHARS + 1) };
  assert.equal(parser.buildToolCall('f', big), null);
});

test('buildToolCall: cyclic arguments -> null', () => {
  const a = {};
  a.self = a;
  assert.equal(parser.buildToolCall('f', a), null);
});

// ---------------------------------------------------------------------------
// coerceToolCallObject
// ---------------------------------------------------------------------------
test('coerceToolCallObject: tool_call', () => {
  const tc = parser.coerceToolCallObject({ tool_call: { name: 'f', arguments: { a: 1 } } });
  assert.equal(tc.name, 'f');
  assert.deepEqual(JSON.parse(tc.arguments), { a: 1 });
});

test('coerceToolCallObject: function_call with a nested function', () => {
  const tc = parser.coerceToolCallObject({
    function_call: { function: { name: 'f', arguments: '{"a":1}' } },
  });
  assert.equal(tc.name, 'f');
});

test('coerceToolCallObject: tool_calls array with one element', () => {
  const tc = parser.coerceToolCallObject({
    tool_calls: [{ function: { name: 'f', arguments: '{}' } }],
  });
  assert.equal(tc.name, 'f');
});

test('coerceToolCallObject: tool_calls array with two elements -> null', () => {
  const tc = parser.coerceToolCallObject({
    tool_calls: [{ function: { name: 'f' } }, { function: { name: 'g' } }],
  });
  assert.equal(tc, null);
});

test('coerceToolCallObject: allowBare', () => {
  const tc = parser.coerceToolCallObject({ name: 'f', arguments: '{}' }, { allowBare: true });
  assert.equal(tc.name, 'f');
});

test('coerceToolCallObject: without allowBare -> null', () => {
  assert.equal(parser.coerceToolCallObject({ name: 'f', arguments: '{}' }), null);
});

test('coerceToolCallObject: input instead of arguments', () => {
  const tc = parser.coerceToolCallObject({ tool_call: { name: 'f', input: { a: 1 } } });
  assert.deepEqual(JSON.parse(tc.arguments), { a: 1 });
});

test('coerceToolCallObject: null/array -> null', () => {
  assert.equal(parser.coerceToolCallObject(null), null);
  assert.equal(parser.coerceToolCallObject([]), null);
});

// ---------------------------------------------------------------------------
// parseJsonToolCandidate
// ---------------------------------------------------------------------------
test('parseJsonToolCandidate: successful parse', () => {
  const tc = parser.parseJsonToolCandidate(
    '{"tool_call":{"name":"f","arguments":{"x":1}}}',
    'test',
    {},
    silentLog,
  );
  assert.equal(tc.name, 'f');
});

test('parseJsonToolCandidate: invalid JSON -> null', () => {
  assert.equal(parser.parseJsonToolCandidate('{oops', 'test', {}, silentLog), null);
});

// ---------------------------------------------------------------------------
// canonicalizeToolMarkupTag / normalizeToolMarkupTags
// ---------------------------------------------------------------------------
test('canonicalizeToolMarkupTag: DSML tool_calls', () => {
  assert.equal(parser.canonicalizeToolMarkupTag('|DSML|tool_calls'), '<tool_calls>');
});

test('canonicalizeToolMarkupTag: closing tag', () => {
  assert.equal(parser.canonicalizeToolMarkupTag('/|DSML|invoke'), '</invoke>');
});

test('canonicalizeToolMarkupTag: parameter with attributes', () => {
  assert.equal(
    parser.canonicalizeToolMarkupTag('|DSML|parameter name="x"'),
    '<parameter name="x">',
  );
});

test('canonicalizeToolMarkupTag: name="..." -> direct', () => {
  assert.equal(parser.canonicalizeToolMarkupTag('name="foo"'), '<direct name="foo">');
});

test('canonicalizeToolMarkupTag: foreign tag -> null', () => {
  assert.equal(parser.canonicalizeToolMarkupTag('div'), null);
});

test('canonicalizeToolMarkupTag: function_calls -> tool_calls', () => {
  assert.equal(parser.canonicalizeToolMarkupTag('|DSML|function_calls'), '<tool_calls>');
});

test('canonicalizeToolMarkupTag: short calls wrapper -> tool_calls', () => {
  assert.equal(parser.canonicalizeToolMarkupTag('|DSML|calls'), '<tool_calls>');
  assert.equal(parser.canonicalizeToolMarkupTag('/|DSML|calls'), '</tool_calls>');
});

test('normalizeToolMarkupTags: plain `calls` outside angle brackets is left alone', () => {
  // The `calls` shorthand is only a tag inside <...>. In free text it must not
  // be rewritten, and the text must still look like non-markup.
  const text = 'The function calls into the parser.';
  assert.equal(parser.normalizeToolMarkupTags(text), text);
  assert.equal(parser.looksLikeToolCallMarkup(text), false);
});

test('normalizeToolMarkupTags: full-width brackets', () => {
  const out = parser.normalizeToolMarkupTags('＜|DSML|invoke＞');
  assert.equal(out, '<invoke>');
});

test('normalizeToolMarkupTags: leaves foreign tags alone', () => {
  assert.equal(parser.normalizeToolMarkupTags('<div>x</div>'), '<div>x</div>');
});

// ---------------------------------------------------------------------------
// decodeDsmlValue / decodeDsmlParameterValue
// ---------------------------------------------------------------------------
test('decodeDsmlValue: all entities', () => {
  assert.equal(
    parser.decodeDsmlValue('&quot;&apos;&lt;&gt;&amp;'),
    '"\'<>&',
  );
});

test('decodeDsmlParameterValue: CDATA', () => {
  assert.equal(parser.decodeDsmlParameterValue('<![CDATA[raw <b>]]>'), 'raw <b>');
});

test('decodeDsmlParameterValue: plain value', () => {
  assert.equal(parser.decodeDsmlParameterValue('&lt;x&gt;'), '<x>');
});

// ---------------------------------------------------------------------------
// getMarkupAttribute
// ---------------------------------------------------------------------------
test('getMarkupAttribute: double quotes', () => {
  assert.equal(parser.getMarkupAttribute(' name="foo" ', 'name'), 'foo');
});

test('getMarkupAttribute: single quotes', () => {
  assert.equal(parser.getMarkupAttribute(" name='foo' ", 'name'), 'foo');
});

test('getMarkupAttribute: missing -> null', () => {
  assert.equal(parser.getMarkupAttribute('name="foo"', 'bar'), null);
});

// ---------------------------------------------------------------------------
// readDsmlTagAt / scanDsmlStructuralTags
// ---------------------------------------------------------------------------
test('readDsmlTagAt: opening invoke', () => {
  const tag = parser.readDsmlTagAt('<invoke name="f">', 0);
  assert.equal(tag.name, 'invoke');
  assert.equal(tag.closing, false);
  assert.equal(tag.selfClosing, false);
});

test('readDsmlTagAt: closing', () => {
  const tag = parser.readDsmlTagAt('</invoke>', 0);
  assert.equal(tag.name, 'invoke');
  assert.equal(tag.closing, true);
});

test('readDsmlTagAt: self-closing', () => {
  const tag = parser.readDsmlTagAt('<parameter name="x"/>', 0);
  assert.equal(tag.selfClosing, true);
});

test('readDsmlTagAt: > inside quotes does not end the tag', () => {
  const tag = parser.readDsmlTagAt('<parameter name="a>b">', 0);
  assert.equal(tag.name, 'parameter');
  assert.equal(tag.attrs.includes('a>b'), true);
});

test('readDsmlTagAt: unclosed tag -> invalid', () => {
  const tag = parser.readDsmlTagAt('<invoke name="f"', 0);
  assert.deepEqual(tag, { invalid: true });
});

test('readDsmlTagAt: foreign tag -> null', () => {
  assert.equal(parser.readDsmlTagAt('<div>', 0), null);
});

test('scanDsmlStructuralTags: CDATA is skipped', () => {
  const tags = parser.scanDsmlStructuralTags('<![CDATA[<invoke>]]>');
  assert.deepEqual(tags, []);
});

test('scanDsmlStructuralTags: unclosed CDATA -> null', () => {
  assert.equal(parser.scanDsmlStructuralTags('<![CDATA[abc'), null);
});

test('scanDsmlStructuralTags: tag sequence', () => {
  const tags = parser.scanDsmlStructuralTags('<invoke></invoke>');
  assert.equal(tags.length, 2);
  assert.equal(tags[0].closing, false);
  assert.equal(tags[1].closing, true);
});

// ---------------------------------------------------------------------------
// parseDsmlInvoke
// ---------------------------------------------------------------------------
test('parseDsmlInvoke: parameters', () => {
  const tc = parser.parseDsmlInvoke(
    'f',
    '<parameter name="x" string="false">1</parameter>',
  );
  assert.equal(tc.name, 'f');
  assert.deepEqual(JSON.parse(tc.arguments), { x: 1 });
});

test('parseDsmlInvoke: string parameter by default', () => {
  const tc = parser.parseDsmlInvoke('f', '<parameter name="x">hello</parameter>');
  assert.deepEqual(JSON.parse(tc.arguments), { x: 'hello' });
});

test('parseDsmlInvoke: duplicate name -> null', () => {
  const tc = parser.parseDsmlInvoke(
    'f',
    '<parameter name="x">1</parameter><parameter name="x">2</parameter>',
  );
  assert.equal(tc, null);
});

test('parseDsmlInvoke: parameter with an invalid name -> null', () => {
  const tc = parser.parseDsmlInvoke('f', '<parameter name="bad name">1</parameter>');
  assert.equal(tc, null);
});

test('parseDsmlInvoke: string="false" with invalid JSON -> null', () => {
  const tc = parser.parseDsmlInvoke(
    'f',
    '<parameter name="x" string="false">not json</parameter>',
  );
  assert.equal(tc, null);
});

test('parseDsmlInvoke: no parameters — JSON body', () => {
  const tc = parser.parseDsmlInvoke('f', '{"a":1}');
  assert.deepEqual(JSON.parse(tc.arguments), { a: 1 });
});

test('parseDsmlInvoke: no parameters and no body -> {}', () => {
  const tc = parser.parseDsmlInvoke('f', '');
  assert.equal(tc.arguments, '{}');
});

test('parseDsmlInvoke: extra text between parameters -> null', () => {
  const tc = parser.parseDsmlInvoke(
    'f',
    'garbage<parameter name="x">1</parameter>',
  );
  assert.equal(tc, null);
});

test('parseDsmlInvoke: nested foreign tag -> null', () => {
  const tc = parser.parseDsmlInvoke('f', '<invoke name="g"></invoke>');
  assert.equal(tc, null);
});

test('parseDsmlInvoke: CDATA in a parameter value', () => {
  const tc = parser.parseDsmlInvoke(
    'f',
    '<parameter name="x"><![CDATA[a<b]]></parameter>',
  );
  assert.deepEqual(JSON.parse(tc.arguments), { x: 'a<b' });
});

// ---------------------------------------------------------------------------
// extractToolCallScope
// ---------------------------------------------------------------------------
test('extractToolCallScope: tool_calls wrapper', () => {
  const scope = parser.extractToolCallScope(
    '<tool_calls><invoke name="f"></invoke></tool_calls>',
  );
  assert.equal(scope, '<invoke name="f"></invoke>');
});

test('extractToolCallScope: no wrapper -> null', () => {
  assert.equal(parser.extractToolCallScope('<invoke name="f"></invoke>'), null);
});

test('extractToolCallScope: two opening wrappers -> null', () => {
  assert.equal(
    parser.extractToolCallScope('<tool_calls><tool_calls></tool_calls></tool_calls>'),
    null,
  );
});

// ---------------------------------------------------------------------------
// parseDsmlToolCall
// ---------------------------------------------------------------------------
test('parseDsmlToolCall: full DSML markup', () => {
  const text =
    '|DSML|tool_calls><|DSML|invoke name="get_weather">' +
    '<|DSML|parameter name="city">Moscow</|DSML|parameter>' +
    '</|DSML|invoke></|DSML|tool_calls>';
  const tc = parser.parseDsmlToolCall(text, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'get_weather');
  assert.deepEqual(JSON.parse(tc.arguments), { city: 'Moscow' });
});

test('parseDsmlToolCall: single invoke without a wrapper', () => {
  const text = '<invoke name="f"><parameter name="x">1</parameter></invoke>';
  const tc = parser.parseDsmlToolCall(text, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseDsmlToolCall: overly large text -> null', () => {
  const big = '<invoke name="f">' + 'x'.repeat(parser.MAX_TOOL_MARKUP_CHARS) + '</invoke>';
  assert.equal(parser.parseDsmlToolCall(big, silentLog), null);
});

test('parseDsmlToolCall: garbage -> null', () => {
  assert.equal(parser.parseDsmlToolCall('hello world', silentLog), null);
});

// ---------------------------------------------------------------------------
// looksLikeToolCallMarkup
// ---------------------------------------------------------------------------
test('looksLikeToolCallMarkup: legacy TOOL_CALL -> false', () => {
  assert.equal(parser.looksLikeToolCallMarkup('TOOL_CALL:foo {}'), false);
});

test('looksLikeToolCallMarkup: DSML real tag form', () => {
  assert.equal(parser.looksLikeToolCallMarkup('<|DSML|invoke name="bash">'), true);
});

test('looksLikeToolCallMarkup: bare |DSML| token in prose -> false', () => {
  assert.equal(parser.looksLikeToolCallMarkup('`|DSML| calls`'), false);
  assert.equal(parser.looksLikeToolCallMarkup('|DSML|invoke'), false);
});

test('looksLikeToolCallMarkup: <tool_call>', () => {
  assert.equal(parser.looksLikeToolCallMarkup('<tool_call>'), true);
});

test('looksLikeToolCallMarkup: JSON with tool_call', () => {
  assert.equal(
    parser.looksLikeToolCallMarkup('{"tool_call":{"name":"f"}}'),
    true,
  );
});

test('looksLikeToolCallMarkup: plain text -> false', () => {
  assert.equal(parser.looksLikeToolCallMarkup('просто текст'), false);
});

// ---------------------------------------------------------------------------
// hasUnclosedToolMarkup
// ---------------------------------------------------------------------------
test('hasUnclosedToolMarkup: legacy TOOL_CALL -> false', () => {
  assert.equal(parser.hasUnclosedToolMarkup('TOOL_CALL:f {"a":1'), false);
});

test('hasUnclosedToolMarkup: unclosed DSML tag', () => {
  assert.equal(parser.hasUnclosedToolMarkup('<|DSML|invoke name="f"'), true);
});

test('hasUnclosedToolMarkup: balanced DSML', () => {
  const text = '<invoke name="f"></invoke>';
  assert.equal(parser.hasUnclosedToolMarkup(text), false);
});

test('hasUnclosedToolMarkup: not markup -> false', () => {
  assert.equal(parser.hasUnclosedToolMarkup('обычный текст'), false);
});

// ---------------------------------------------------------------------------
// parseToolCall (integration)
// ---------------------------------------------------------------------------
test('parseToolCall: strict JSON tool_call', () => {
  const tc = parser.parseToolCall(
    '{"tool_call":{"name":"f","arguments":{"a":1}}}',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseToolCall: fenced JSON', () => {
  const tc = parser.parseToolCall(
    '```json\n{"tool_call":{"name":"f","arguments":{}}}\n```',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseToolCall: fenced shell block surrounded by prose is NOT a tool call', () => {
  // Regression for the agent loop: the model narrates a command in a fenced
  // block inside a normal answer. Synthesizing a bash call here makes the
  // gateway execute it and the agent loops forever.
  const text = 'Вот как это сделать:\n```bash\npwd && ls\n```\nГотово.';
  assert.equal(parser.parseToolCall(text, silentLog), null);
});

test('parseToolCall: a lone fenced shell block becomes a bash call', () => {
  const tc = parser.parseToolCall('```bash\npwd && ls\n```', silentLog);
  assert.ok(tc, 'a lone shell fence is still a real request');
  assert.equal(tc.name, 'bash');
});

test('parseToolCall: lone fenced shell block with a leading blank line still parses', () => {
  const tc = parser.parseToolCall('\n```sh\necho hi\n```\n', silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'bash');
});

test('parseToolCall: legacy TOOL_CALL is no longer supported', () => {
  assert.equal(parser.parseToolCall('TOOL_CALL:get_weather {"city":"Moscow"}', silentLog), null);
});

test('parseToolCall: <tool_call> XML', () => {
  const tc = parser.parseToolCall(
    '<tool_call>{"name":"f","arguments":{"x":1}}</tool_call>',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseToolCall: DSML', () => {
  const text =
    '<tool_calls><invoke name="f"><parameter name="x">1</parameter></invoke></tool_calls>';
  const tc = parser.parseToolCall(text, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseToolCall: overly large text -> null', () => {
  const big = 'x'.repeat(parser.MAX_TOOL_MARKUP_CHARS + 1);
  assert.equal(parser.parseToolCall(big, silentLog), null);
});

test('parseToolCall: empty/invalid input -> null', () => {
  assert.equal(parser.parseToolCall('', silentLog), null);
  assert.equal(parser.parseToolCall(null, silentLog), null);
  assert.equal(parser.parseToolCall(undefined, silentLog), null);
  assert.equal(parser.parseToolCall(123, silentLog), null);
});

test('parseToolCall: no matches -> null', () => {
  assert.equal(parser.parseToolCall('просто текст без вызовов', silentLog), null);
});

test('parseToolCall: DSML marker but broken -> null', () => {
  assert.equal(parser.parseToolCall('<|DSML|invoke name="f"', silentLog), null);
});

test('parseToolCall: valid inline JSON wins over a trailing truncated DSML copy', () => {
  // Regression: a complete JSON call followed by a duplicate (truncated)
  // DSML/XML rendering. The JSON is authoritative and must not be discarded
  // just because a stray DSML marker appears later in the text.
  const text =
    '{"tool_call":{"name":"edit","arguments":{"path":"lib/recovery.js"}}}' +
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n' +
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="edit">\n' +
    '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="path">lib/recovery.js<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>';
  const tc = parser.parseToolCall(text, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'edit');
  assert.equal(JSON.parse(tc.arguments).path, 'lib/recovery.js');
});

test('parseToolCall: inline JSON without a wrapper', () => {
  const tc = parser.parseToolCall(
    'Ответ: {"tool_call":{"name":"f","arguments":{"a":1}}} конец',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

// ---------------------------------------------------------------------------
// repairJsonText
// ---------------------------------------------------------------------------
//
// repairJsonText — non-destructive local JSON repair for the glitches
// DeepSeek regularly produces: raw control characters inside strings and
// trailing commas. Without the repair such calls fell into "malformed
// tool-call markup" and caused a session reset / account rotation.

test('repairJsonText: valid JSON is unchanged', () => {
  const input = '{"a":1,"b":[1,2]}';
  assert.equal(parser.repairJsonText(input), input);
});

test('repairJsonText: raw newline inside a string -> \\n', () => {
  const input = '{"command":"echo line1\nline2"}';
  const out = parser.repairJsonText(input);
  assert.equal(out, '{"command":"echo line1\\nline2"}');
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).command, 'echo line1\nline2');
});

test('repairJsonText: raw tab/CR/BS/FF inside a string are escaped', () => {
  const input = '{"s":"a\tb\rc\bd\fe"}';
  const out = parser.repairJsonText(input);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).s, 'a\tb\rc\bd\fe');
});

test('repairJsonText: other control char -> \\uXXXX', () => {
  const input = '{"s":"a\u0001b"}';
  const out = parser.repairJsonText(input);
  assert.ok(out.includes('\\u0001'));
  assert.doesNotThrow(() => JSON.parse(out));
});

test('repairJsonText: trailing comma before } and ]', () => {
  assert.equal(parser.repairJsonText('{"a":1,}'), '{"a":1}');
  assert.equal(parser.repairJsonText('[1,2,]'), '[1,2]');
  assert.equal(parser.repairJsonText('{"a":[1,],}'), '{"a":[1]}');
});

test('repairJsonText: a comma inside a string is left alone', () => {
  const input = '{"s":"a,}"}'; // "a,}" inside a string
  assert.equal(parser.repairJsonText(input), input);
  assert.doesNotThrow(() => JSON.parse(input));
});

test('repairJsonText: an escaped quote does not toggle the string state', () => {
  // \" inside a string, then a raw \n must stay inside the string
  const input = '{"s":"a\\"b\nc"}';
  const out = parser.repairJsonText(input);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).s, 'a"b\nc');
});

test('repairJsonText: empty/non-string input is returned as is', () => {
  assert.equal(parser.repairJsonText(''), '');
  assert.equal(parser.repairJsonText(null), '');
  assert.equal(parser.repairJsonText(undefined), '');
});

// ---------------------------------------------------------------------------
// parseJsonToolCandidate: repair during JSON.parse
// ---------------------------------------------------------------------------

test('parseJsonToolCandidate: fixes a trailing comma and logs -repaired', () => {
  const logs = [];
  const tc = parser.parseJsonToolCandidate(
    '{"tool_call":{"name":"f","arguments":{"a":1,},},}',
    'inline',
    {},
    (m) => logs.push(m),
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
  assert.equal(tc.arguments, '{"a":1}');
  assert.ok(logs.some((m) => m.includes('SUCCESS inline-repaired')), 'there must be a -repaired log line');
});

test('parseJsonToolCandidate: fixes a raw newline in an argument', () => {
  const tc = parser.parseJsonToolCandidate(
    '{"tool_call":{"name":"f","arguments":{"cmd":"echo a\nb"}}}',
    'inline',
    {},
    silentLog,
  );
  assert.ok(tc);
  assert.equal(JSON.parse(tc.arguments).cmd, 'echo a\nb');
});

test('parseJsonToolCandidate: unrepairable JSON -> null', () => {
  assert.equal(
    parser.parseJsonToolCandidate('{"tool_call":{"name":"f"', 'inline', {}, silentLog),
    null,
  );
  assert.equal(
    parser.parseJsonToolCandidate('{tool_call:{name:f}}', 'inline', {}, silentLog),
    null,
  );
});

// ---------------------------------------------------------------------------
// repairUnescapedQuotes
// ---------------------------------------------------------------------------
//
// The most damaging DeepSeek glitch: a raw `"` inside a string value (a big
// `newText` full of `echo "..."`). It desyncs the brace scanner, so the whole
// tool call was lost as plain text. repairJsonText cannot fix it; this pass
// escapes the literal quotes that are not a legal end-of-value boundary.

test('repairUnescapedQuotes: valid JSON is unchanged', () => {
  const input = '{"a":"b","c":"d"}';
  assert.equal(parser.repairUnescapedQuotes(input), input);
});

test('repairUnescapedQuotes: an escaped quote is left alone', () => {
  const input = '{"a":"x \\" y"}';
  assert.equal(parser.repairUnescapedQuotes(input), input);
  assert.doesNotThrow(() => JSON.parse(input));
});

test('repairUnescapedQuotes: raw quote inside a value is escaped', () => {
  const input = '{"a":"echo "hi" now"}';
  const out = parser.repairUnescapedQuotes(input);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).a, 'echo "hi" now');
});

test('repairUnescapedQuotes: a run of two quotes before } keeps the last as the closer', () => {
  const input = '{"a":"trailing""}';
  const out = parser.repairUnescapedQuotes(input);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).a, 'trailing"');
});

test('repairUnescapedQuotes: empty/non-string input is returned as is', () => {
  assert.equal(parser.repairUnescapedQuotes(''), '');
  assert.equal(parser.repairUnescapedQuotes(null), '');
  assert.equal(parser.repairUnescapedQuotes(undefined), '');
});

// ---------------------------------------------------------------------------
// parseToolCall: repair end-to-end
// ---------------------------------------------------------------------------

test('parseToolCall: trailing comma in inline JSON', () => {
  const tc = parser.parseToolCall(
    'Ок: {"tool_call":{"name":"bash","arguments":{"command":"ls",},}}',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'bash');
  assert.equal(tc.arguments, '{"command":"ls"}');
});

test('parseToolCall: raw newline in a command argument', () => {
  const tc = parser.parseToolCall(
    '{"tool_call":{"name":"bash","arguments":{"command":"echo line1\nline2"}}}',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'bash');
  assert.equal(JSON.parse(tc.arguments).command, 'echo line1\nline2');
});

// The exact shape from the production log: a large `newText` full of raw
// newlines/tabs AND unescaped quotes from `@echo "..."`.
test('parseToolCall: raw quotes and raw newlines inside a large newText', () => {
  const input = '{"tool_call":{"name":"edit","arguments":{"path":"/x/Makefile","edits":[{"oldText":"A","newText":"# X\n\t@echo "=== DONE ==="\nclean:\n\t@echo "cleaned target/, and launcher""}]}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc, 'the call must be recovered, not lost as plain text');
  assert.equal(tc.name, 'edit');
  const args = JSON.parse(tc.arguments);
  assert.equal(args.edits[0].newText, '# X\n\t@echo "=== DONE ==="\nclean:\n\t@echo "cleaned target/, and launcher"');
});

test('parseToolCall: escaped quotes inside a value still parse', () => {
  const input = '{"tool_call":{"name":"edit","arguments":{"path":"/x/Makefile","edits":[{"oldText":"A","newText":"# X\n\t@echo \\"=== DONE ===\\"\nclean:\n\t@echo \\"cleaned target/, and launcher\\""}]}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'edit');
});

// ---------------------------------------------------------------------------
// hasUnclosedToolMarkup: JSON branch
// ---------------------------------------------------------------------------
//
// Before the fix the JSON branch did not exist and the function always
// returned false for JSON, so recovery.js skipped completion/retry and
// immediately reset the session / rotated the account on "balanced but invalid" JSON.

test('hasUnclosedToolMarkup: balanced valid JSON -> false', () => {
  assert.equal(
    parser.hasUnclosedToolMarkup('{"tool_call":{"name":"f","arguments":{"a":1}}}'),
    false,
  );
});

test('hasUnclosedToolMarkup: repairable trailing comma -> false', () => {
  // repairJsonText fixes it, parseToolCall succeeds => not "broken"
  assert.equal(
    parser.hasUnclosedToolMarkup('{"tool_call":{"name":"f","arguments":{"a":1,},}}'),
    false,
  );
});

test('hasUnclosedToolMarkup: repairable raw newline -> false', () => {
  assert.equal(
    parser.hasUnclosedToolMarkup('{"tool_call":{"name":"f","arguments":{"s":"a\nb"}}}'),
    false,
  );
});

test('hasUnclosedToolMarkup: repairable unescaped quotes -> false', () => {
  // repairUnescapedQuotes fixes it, parseToolCall succeeds => not "broken"
  assert.equal(
    parser.hasUnclosedToolMarkup('{"tool_call":{"name":"f","arguments":{"s":"a "b" c"}}}'),
    false,
  );
});

test('hasUnclosedToolMarkup: unrepairable JSON with a tool_call key -> true', () => {
  assert.equal(
    parser.hasUnclosedToolMarkup('{"tool_call":{"name":"f","arguments":{"a":1}'),
    true,
  );
});

test('hasUnclosedToolMarkup: unrepairable JSON tool_calls array -> true', () => {
  assert.equal(
    parser.hasUnclosedToolMarkup('{"tool_calls":[{"function":{"name":"f"'),
    true,
  );
});

test('hasUnclosedToolMarkup: not markup -> false', () => {
  assert.equal(parser.hasUnclosedToolMarkup('обычный текст'), false);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
test('exported constants are defined and positive', () => {
  for (const key of [
    'MAX_TOOL_MARKUP_CHARS',
    'MAX_TOOL_ARGUMENT_CHARS',
    'MAX_TOOL_JSON_CANDIDATES',
    'MAX_DSML_PARAMETERS',
    'MAX_DSML_STRUCTURAL_TAGS',
    'MAX_DSML_TAG_CHARS',
  ]) {
    assert.equal(typeof parser[key], 'number', key);
    assert.ok(parser[key] > 0, key);
  }
});

test('repairJsonText is exported and is a function', () => {
  assert.equal(typeof parser.repairJsonText, 'function');
});

// ---------------------------------------------------------------------------
// repairXmlLikeKeys / parseToolCall: XML-like keys + glued literals
// ---------------------------------------------------------------------------
//
// Production log shape: the model used attribute syntax for the call id and
// glued the next key onto the id string literal, so the object never parsed
// even after repairJsonText / repairUnescapedQuotes.

test('repairXmlLikeKeys: attribute key becomes a JSON member', () => {
  const input = '{"tool_call":{ id="call_1""name":"read","arguments":{"path":"/x"}}}';
  const out = parser.repairXmlLikeKeys(input);
  assert.equal(out, '{"tool_call":{ "id":"call_1","name":"read","arguments":{"path":"/x"}}}');
});

test('repairXmlLikeKeys: valid JSON is unchanged', () => {
  const input = '{"tool_call":{"name":"read","arguments":{}}}';
  assert.equal(parser.repairXmlLikeKeys(input), input);
});

test('parseToolCall: XML-like id key with a glued next key', () => {
  const input = '{"tool_call":{ id="call_1""name":"read","arguments":{"path":"/x"}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc, 'the call must be recovered, not lost as plain text');
  assert.equal(tc.name, 'read');
  assert.deepEqual(JSON.parse(tc.arguments), { path: '/x' });
});

test('parseToolCall: XML-like id key with a large content value', () => {
  const input = '{"tool_call":{ id="call_x""name":"write","arguments":{"path":"/tmp/p.js","content":"const a = 1;\\n"}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'write');
  const args = JSON.parse(tc.arguments);
  assert.equal(args.path, '/tmp/p.js');
  assert.equal(args.content, 'const a = 1;\n');
});

// ---------------------------------------------------------------------------
// repairStrayClosingQuote / parseToolCall: value missing its closing quote
// ---------------------------------------------------------------------------
//
// Production log shape (`[markup-dump] len=248`): the model wrote a numeric
// value, then a stray `"` and then the object's closing braces:
//
//   {"tool_call":{"name":"read","arguments":{"path":"/x","limit":35"}}}
//
// That lone quote toggles the brace scanner's string state, so no balanced
// object is extracted and every other repair is unreachable. The stray quote
// must be dropped for the call to be recovered without a completion round.

test('repairStrayClosingQuote: drops the quote before the trailing braces', () => {
  const input = '{"tool_call":{"name":"read","arguments":{"path":"/x","limit":35"}}}';
  const out = parser.repairStrayClosingQuote(input);
  assert.equal(out, '{"tool_call":{"name":"read","arguments":{"path":"/x","limit":35}}}');
});

test('repairStrayClosingQuote: valid JSON is unchanged', () => {
  const input = '{"tool_call":{"name":"read","arguments":{"path":"/x","limit":35}}}';
  assert.equal(parser.repairStrayClosingQuote(input), input);
});

test('parseToolCall: value missing its closing quote before the braces', () => {
  const input = '{"tool_call":{"name":"read","arguments":{"path":"/x","limit":35"}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc, 'the call must be recovered, not lost as plain text');
  assert.equal(tc.name, 'read');
  assert.deepEqual(JSON.parse(tc.arguments), { path: '/x', limit: 35 });
});

test('parseToolCall: stray-quote shape with surrounding prose (log dump len=248)', () => {
  const input = 'Both cases recover. Now let me add regression tests.\n\n'
    + '{"tool_call":{"name":"read","arguments":{"path":"/home/user/Projects/ds/test/parser.test.js","offset":730,"limit":35"}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc);
  assert.equal(tc.name, 'read');
  const args = JSON.parse(tc.arguments);
  assert.equal(args.path, '/home/user/Projects/ds/test/parser.test.js');
  assert.equal(args.offset, 730);
  assert.equal(args.limit, 35);
  assert.equal(parser.hasUnclosedToolMarkup(input), false,
    'a recoverable stray quote must not trigger a completion round');
});