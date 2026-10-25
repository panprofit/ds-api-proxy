'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../lib/parser.js');

const silentLog = () => {};

const CORPUS = require('./fixtures/broken-tool-calls');

for (const entry of CORPUS) {
    test(`corpus: ${entry.name}`, () => {
        const tc = parser.parseToolCall(entry.input, () => {});
        if (entry.call === null) {
            assert.equal(tc, null, `expected no call, got ${JSON.stringify(tc)}`);
            return;
        }
        assert.ok(tc, 'expected a parsed tool call');
        assert.equal(tc.name, entry.call.name);
        const args = JSON.parse(tc.arguments);
        if (entry.call.argsAny) {
            assert.equal(typeof args, 'object');
        } else {
            assert.deepEqual(args, entry.call.args);
        }
    });
}

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

test('extractBalancedJsonObjects: escaped quotes inside a string', () => {
  const text = '{"tool_call":{"name":"bash","arguments":{"command":"echo \\"hi\\""}}}';
  const objs = parser.extractBalancedJsonObjects(text);
  assert.equal(objs.length, 1);
  assert.doesNotThrow(() => JSON.parse(objs[0]));
});

test('extractBalancedJsonObjects: escaped backslash inside a string', () => {

  const text = '{"s":"a\\\\b","n":1}';
  assert.deepEqual(parser.extractBalancedJsonObjects(text), [text]);
  assert.doesNotThrow(() => JSON.parse(text));
});

test('takeJsonParseError: returns the reason for the last JSON.parse error', () => {

  parser.parseToolCall('{"tool_call":{"name":"edit","arguments":{"path":/x}}}', () => {});
  const err = parser.takeJsonParseError();
  assert.ok(err && typeof err === 'string', 'expected an error string');

  assert.equal(parser.takeJsonParseError(), null);
});

test('takeJsonParseError: null after a successful parse', () => {
  const tc = parser.parseToolCall('{"tool_call":{"name":"edit","arguments":{"path":"/x"}}}', () => {});
  assert.ok(tc);
  assert.equal(parser.takeJsonParseError(), null);
});

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

test('getMarkupAttribute: double quotes', () => {
  assert.equal(parser.getMarkupAttribute(' name="foo" ', 'name'), 'foo');
});

test('getMarkupAttribute: single quotes', () => {
  assert.equal(parser.getMarkupAttribute(" name='foo' ", 'name'), 'foo');
});

test('getMarkupAttribute: missing -> null', () => {
  assert.equal(parser.getMarkupAttribute('name="foo"', 'bar'), null);
});

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

test('extractToolCallScope: tool_calls wrapper', () => {
  const scope = parser.extractToolCallScope(
    '<tool_calls><invoke name="f"></invoke></tool_calls>',
  );
  assert.equal(scope, '<invoke name="f"></invoke>');
});

test('extractToolCallScope: no wrapper -> null', () => {
  assert.equal(parser.extractToolCallScope('<invoke name="f"></invoke>'), null);
});

test('extractToolCallScope: duplicate opening wrappers are tolerated', () => {

  const scope = parser.extractToolCallScope(
    '<tool_calls><tool_calls><invoke name="f"></invoke></tool_calls></tool_calls>',
  );
  assert.equal(scope, '<tool_calls><invoke name="f"></invoke></tool_calls>');
});

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

test('parseToolCall: pipe-prefixed <| tool_call> XML', () => {
  const tc = parser.parseToolCall(
    '<| tool_call>{"name":"f","arguments":{"x":1}}</| tool_call>',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
  assert.deepEqual(JSON.parse(tc.arguments), { x: 1 });
});

test('parseToolCall: pipe-prefixed XML without spaces', () => {
  const tc = parser.parseToolCall(
    '<|tool_call>{"name":"f","arguments":{}}</|tool_call>',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseToolCall: pipe-delimited <| tool_call |> XML', () => {
  const tc = parser.parseToolCall(
    '<| tool_call |>{"name":"f","arguments":{"x":1}}</| tool_call |>',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
  assert.deepEqual(JSON.parse(tc.arguments), { x: 1 });
});

test('parseToolCall: pipe-delimited XML with the slash inside the pipe', () => {
  const tc = parser.parseToolCall(
    '<| tool_call |>{"name":"f","arguments":{}}<| /tool_call |>',
    silentLog,
  );
  assert.ok(tc);
  assert.equal(tc.name, 'f');
});

test('parseToolCalls: returns every pipe-prefixed XML call', () => {
  const text = '<| tool_call>{"name":"read","arguments":{"path":"/a"}}</| tool_call>\n'
    + '<| tool_call>{"name":"bash","arguments":{"command":"ls"}}</| tool_call>';
  const calls = parser.parseToolCalls(text, silentLog);
  assert.deepEqual(calls.map(call => call.name), ['read', 'bash']);
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
  const input = '{"s":"a,}"}';
  assert.equal(parser.repairJsonText(input), input);
  assert.doesNotThrow(() => JSON.parse(input));
});

test('repairJsonText: an escaped quote does not toggle the string state', () => {

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

test('exported limits are the same values as parser-limits.js', () => {

  const limits = require('../lib/parser-limits');
  for (const key of [
    'MAX_TOOL_MARKUP_CHARS',
    'MAX_TOOL_ARGUMENT_CHARS',
    'MAX_TOOL_JSON_CANDIDATES',
    'MAX_DSML_PARAMETERS',
    'MAX_DSML_STRUCTURAL_TAGS',
    'MAX_DSML_TAG_CHARS',
  ]) {
    assert.equal(parser[key], limits[key], key);
  }
});

test('repairJsonText is exported and is a function', () => {
  assert.equal(typeof parser.repairJsonText, 'function');
});

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

test('parseToolCall: bare arguments key glued to the previous value', () => {
  const input = '{"tool_call":{ id="call_b0a1c2d3e4f50617" name="codemode" arguments:{"code":"return a;"}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc, 'the call must be recovered, not lost as plain text');
  assert.equal(tc.name, 'codemode');
  assert.deepEqual(JSON.parse(tc.arguments), { code: 'return a;' });
});

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
});

test('parseToolCall: JSON tool_call inside a fence surrounded by prose is ignored', () => {
  const input = 'Пример:\n```json\n{"tool_call":{"name":"read","arguments":{"path":"/f"}}}\n```\nГотово.';
  assert.equal(parser.parseToolCall(input, silentLog), null);
});

test('parseToolCall: XML <tool_call> wrapper inside a fence surrounded by prose is ignored', () => {
  const input = 'Example:\n```xml\n<tool_call>{"name":"read","arguments":{"path":"/f"}}</tool_call>\n```\ndone';
  assert.equal(parser.parseToolCall(input, silentLog), null);
});

test('parseToolCall: DSML markup inside a fence surrounded by prose is ignored', () => {
  const input = 'Example:\n```xml\n<tool_calls><invoke name="read"><parameter name="path">/f</parameter></invoke></tool_calls>\n```\ndone';
  assert.equal(parser.parseToolCall(input, silentLog), null);
});

test('parseToolCall: whole-message fenced JSON still parses', () => {
  const input = '```json\n{"tool_call":{"name":"read","arguments":{"path":"/f"}}}\n```';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc, 'a fence that is the whole message is a real request');
  assert.equal(tc.name, 'read');
});

test('parseToolCall: bare JSON tool_call next to (but outside) a fence still parses', () => {
  const input = 'See this example:\n```bash\nls\n```\nNow: {"tool_call":{"name":"read","arguments":{"path":"/f"}}}';
  const tc = parser.parseToolCall(input, silentLog);
  assert.ok(tc, 'markup outside the fence is authoritative');
  assert.equal(tc.name, 'read');
});

test('blankFencedBlocks: replaces a fence with equal-length spaces', () => {
  const input = 'a\n```json\nx\n```\nb';
  const out = parser.blankFencedBlocks(input);
  assert.equal(out.length, input.length);
  assert.ok(!out.includes('```'), 'the fence markers must be gone');
  assert.equal(out.trimStart().startsWith('a'), true);
  assert.equal(out.trimEnd().endsWith('b'), true);
});

test('hasProseOutsideFences: false for a whole-message fence, true otherwise', () => {
  assert.equal(parser.hasProseOutsideFences('```json\n{}\n```'), false);
  assert.equal(parser.hasProseOutsideFences('intro\n```json\n{}\n```\noutro'), true);
  assert.equal(parser.hasProseOutsideFences('no fence at all'), false);
});

test('parseToolCalls: returns every DSML invoke', () => {
  const text = '<tool_calls>\n<invoke name="read"><parameter name="path">/x</parameter></invoke>\n'
    + '<invoke name="bash"><parameter name="command">ls</parameter></invoke>\n</tool_calls>';
  const calls = parser.parseToolCalls(text, silentLog);
  assert.deepEqual(calls.map(call => call.name), ['read', 'bash']);
});

test('parseToolCalls: returns every native marker call', () => {
  const body = JSON.stringify([
    { name: 'read', arguments: { path: '/x' } },
    { name: 'bash', arguments: { command: 'ls' } },
  ]);
  const calls = parser.parseToolCalls(`<|tool\u2581calls\u2581begin|>${body}<|tool\u2581calls\u2581end|>`, silentLog);
  assert.deepEqual(calls.map(call => call.name), ['read', 'bash']);
});

test('parseToolCalls: falls back to a single JSON tool call', () => {
  const calls = parser.parseToolCalls('{"tool_call":{"name":"read","arguments":{"path":"/f"}}}', silentLog);
  assert.deepEqual(calls.map(call => call.name), ['read']);
});

test('parseToolCalls: returns every inline JSON tool call', () => {
  const text = '{"tool_call":{"name":"read","arguments":{"path":"/f"}}}\n\n'
    + '{"tool_call":{"name":"bash","arguments":{"command":"ls"}}}';
  const calls = parser.parseToolCalls(text, silentLog);
  assert.deepEqual(calls.map(call => call.name), ['read', 'bash']);
});

test('parseToolCalls: expands a tool_calls array', () => {
  const text = '{"tool_calls":[{"function":{"name":"read","arguments":{"path":"/f"}}},'
    + '{"function":{"name":"bash","arguments":{"command":"ls"}}}]}';
  const calls = parser.parseToolCalls(text, silentLog);
  assert.deepEqual(calls.map(call => call.name), ['read', 'bash']);
});

test('parseToolCalls: ignores DSML markup inside a fenced example surrounded by prose', () => {
  const input = 'Example:\n```xml\n<tool_calls><invoke name="read"><parameter name="path">/f</parameter></invoke></tool_calls>\n```\ndone';
  assert.deepEqual(parser.parseToolCalls(input, silentLog), []);
});
