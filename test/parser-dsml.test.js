'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const d = require('../lib/parser-dsml');

test('canonicalizeToolMarkupTag: normalizes the DSML pipe form', () => {
    assert.equal(d.canonicalizeToolMarkupTag('|DSML| invoke name="f"'), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag('/|DSML| tool_calls'), '</tool_calls>');
});

test('canonicalizeToolMarkupTag: maps the `calls` short wrapper to tool_calls', () => {
    assert.equal(d.canonicalizeToolMarkupTag('calls'), '<tool_calls>');
    assert.equal(d.canonicalizeToolMarkupTag('/calls'), '</tool_calls>');
});

test('canonicalizeToolMarkupTag: accepts the V4.1 leading-space tag names', () => {
    const t = '\uFF5CDSML\uFF5C';
    assert.equal(d.canonicalizeToolMarkupTag(`${t} calls`), '<tool_calls>');
    assert.equal(d.canonicalizeToolMarkupTag(`${t} invoke name="f"`), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag(`${t} parameter name="a" string="true"`), '<parameter name="a" string="true">');
});

test('canonicalizeToolMarkupTag: accepts one-sided and bare DSML markers', () => {
    const fw = '\uFF5C';
    assert.equal(d.canonicalizeToolMarkupTag(`${fw}DSML invoke name="f"`), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag(`DSML${fw} invoke name="f"`), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag('DSML invoke name="f"'), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag(`/${fw}DSML invoke`), '</invoke>');
    assert.equal(d.canonicalizeToolMarkupTag(`${fw}DSML${fw}/ invoke`), '</invoke>');
    assert.equal(d.canonicalizeToolMarkupTag(`${fw}DSML${fw} calls`), '<tool_calls>');
});

test('parseDsmlToolCall: every DSML delimiter variant parses', () => {
    const variants = ['\uFF5CDSML\uFF5C', '\uFF5CDSML', 'DSML\uFF5C', 'DSML', '|DSML|', '|DSML', 'DSML|'];
    for (const v of variants) {
        const text = `<${v} calls>\n<${v} invoke name="f">\n<${v} parameter name="a" string="true">1</${v} parameter>\n</${v} invoke>\n</${v} calls>`;
        const call = d.parseDsmlToolCall(text, () => {});
        assert.ok(call, `variant ${JSON.stringify(v)} should parse`);
        assert.deepEqual(JSON.parse(call.arguments), { a: '1' }, `variant ${JSON.stringify(v)} args`);
    }
});

test('readDsmlTagAt: reads a one-sided marker tag', () => {
    assert.equal(d.readDsmlTagAt('<\uFF5CDSML invoke name="f">', 0).name, 'invoke');
    assert.equal(d.readDsmlTagAt('<DSML\uFF5C invoke name="f">', 0).name, 'invoke');
});

test('parseDsmlToolCall: parses a V4.1 namespaced leading-space block', () => {
    const t = '\uFF5CDSML\uFF5C';
    const text = `<${t} calls>\n<${t} invoke name="search::lookup">\n<${t} parameter name="q" string="true">cats</${t} parameter>\n</${t} invoke>\n</${t} calls>`;
    const call = d.parseDsmlToolCall(text, () => {});
    assert.deepEqual(call, { name: 'search::lookup', arguments: '{"q":"cats"}' });
});

test('canonicalizeToolMarkupTag: smart quotes / fullwidth are folded to ASCII', () => {
    assert.match(d.canonicalizeToolMarkupTag('invoke name=“f”'), /^<invoke name="f">$/);
});

test('canonicalizeToolMarkupTag: folds the native U+2581 separator to _', () => {
    assert.equal(d.canonicalizeToolMarkupTag('|DSML| tool\u2581calls'), '<tool_calls>');
    assert.equal(d.canonicalizeToolMarkupTag('/|DSML| tool\u2581calls'), '</tool_calls>');
});

test('readDsmlTagAt: reads a tool▁calls tag with the native separator', () => {
    const tag = d.readDsmlTagAt('<tool\u2581calls>', 0);
    assert.equal(tag.name, 'tool_calls');
});

test('scanDsmlStructuralTags: balances a native-separator tool▁calls wrapper', () => {
    const tags = d.scanDsmlStructuralTags('<tool\u2581calls><invoke name="f"></invoke></tool\u2581calls>');
    assert.deepEqual(tags.map(t => t.name), ['tool_calls', 'invoke', 'invoke', 'tool_calls']);
});

test('canonicalizeToolMarkupTag: `name=` becomes a <direct> tag', () => {
    assert.equal(d.canonicalizeToolMarkupTag('name="read"'), '<direct name="read">');
});

test('canonicalizeToolMarkupTag: non-semantic tags return null', () => {
    assert.equal(d.canonicalizeToolMarkupTag('div class="x"'), null);
    assert.equal(d.canonicalizeToolMarkupTag(''), null);
});

test('normalizeToolMarkupTags: rewrites known tags and leaves others verbatim', () => {
    const out = d.normalizeToolMarkupTags('a ＜|DSML| invoke name="f"> b <div> c');
    assert.match(out, /<invoke name="f">/);
    assert.match(out, /<div>/, 'unrecognized tags are preserved');
    assert.ok(!out.includes('＜'), 'fullwidth angle brackets are folded to ASCII');
});

test('decodeDsmlValue: decodes the standard XML entities', () => {
    assert.equal(d.decodeDsmlValue('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;'), `<a> "b" 'c' &`);
});

test('decodeDsmlParameterValue: unwraps CDATA verbatim', () => {
    assert.equal(d.decodeDsmlParameterValue('<![CDATA[ <raw> & ]]>'), ' <raw> & ');
    assert.equal(d.decodeDsmlParameterValue('<![CDATA[x]]>'), 'x');
});

test('decodeDsmlParameterValue: falls back to entity decoding otherwise', () => {
    assert.equal(d.decodeDsmlParameterValue('a&amp;b'), 'a&b');
});

test('getMarkupAttribute: reads single- and double-quoted values', () => {
    assert.equal(d.getMarkupAttribute('name="read" other="x"', 'name'), 'read');
    assert.equal(d.getMarkupAttribute("name='read'", 'name'), 'read');
});

test('getMarkupAttribute: missing attribute returns null', () => {
    assert.equal(d.getMarkupAttribute('name="read"', 'string'), null);
    assert.equal(d.getMarkupAttribute('', 'name'), null);
});

test('readDsmlTagAt: reads an opening invoke tag with attrs', () => {
    const tag = d.readDsmlTagAt('<invoke name="f">', 0);
    assert.equal(tag.name, 'invoke');
    assert.equal(tag.closing, false);
    assert.equal(tag.selfClosing, false);
    assert.equal(tag.end, '<invoke name="f">'.length);
});

test('readDsmlTagAt: detects a closing tag', () => {
    const tag = d.readDsmlTagAt('</invoke>', 0);
    assert.equal(tag.closing, true);
});

test('readDsmlTagAt: detects a self-closing tag', () => {
    const tag = d.readDsmlTagAt('<parameter name="x"/>', 0);
    assert.equal(tag.selfClosing, true);
});

test('readDsmlTagAt: returns null for unrelated tags and non-`<` starts', () => {
    assert.equal(d.readDsmlTagAt('<div>', 0), null);
    assert.equal(d.readDsmlTagAt('x', 0), null);
});

test('readDsmlTagAt: an unterminated tag reports invalid', () => {
    assert.deepEqual(d.readDsmlTagAt('<invoke name="f"', 0), { invalid: true });
});

test('scanDsmlStructuralTags: collects recognized tags in order', () => {
    const tags = d.scanDsmlStructuralTags('<tool_calls><invoke name="f"></invoke></tool_calls>');
    assert.deepEqual(tags.map(t => t.name), ['tool_calls', 'invoke', 'invoke', 'tool_calls']);
});

test('scanDsmlStructuralTags: skips CDATA sections', () => {
    const tags = d.scanDsmlStructuralTags('<parameter><![CDATA[<not-a-tag>]]></parameter>');
    assert.deepEqual(tags.map(t => t.name), ['parameter', 'parameter']);
});

test('scanDsmlStructuralTags: an unterminated CDATA returns null', () => {
    assert.equal(d.scanDsmlStructuralTags('<parameter><![CDATA[oops'), null);
});

test('parseDsmlParameter: stores a string value by default', () => {
    const args = {};
    const ok = d.parseDsmlParameter('name="x"', 'hello', args, new Set());
    assert.equal(ok, true);
    assert.deepEqual(args, { x: 'hello' });
});

test('parseDsmlParameter: string="false" JSON-decodes the value', () => {
    const args = {};
    d.parseDsmlParameter('name="n" string="false"', ' 42 ', args, new Set());
    assert.deepEqual(args, { n: 42 });
});

test('parseDsmlParameter: string="false" with invalid JSON fails', () => {
    const args = {};
    assert.equal(d.parseDsmlParameter('name="n" string="false"', 'nope', args, new Set()), false);
});

test('parseDsmlParameter: rejects duplicate and malformed names', () => {
    const seen = new Set(['x']);
    assert.equal(d.parseDsmlParameter('name="x"', 'v', {}, seen), false);
    assert.equal(d.parseDsmlParameter('name="bad name"', 'v', {}, new Set()), false);
    assert.equal(d.parseDsmlParameter('other="y"', 'v', {}, new Set()), false);
});

test('parseDsmlInvoke: parses name/parameter pairs into arguments', () => {
    const tc = d.parseDsmlInvoke('read', '<parameter name="path">/x</parameter><parameter name="n" string="false">2</parameter>');
    assert.equal(tc.name, 'read');
    assert.deepEqual(JSON.parse(tc.arguments), { path: '/x', n: 2 });
});

test('parseDsmlInvoke: a body-only invoke yields empty arguments', () => {
    const tc = d.parseDsmlInvoke('ping', '  ');
    assert.deepEqual(JSON.parse(tc.arguments), {});
});

test('parseDsmlInvoke: a lone balanced JSON object body becomes the arguments', () => {
    const tc = d.parseDsmlInvoke('read', '{"path":"/x"}');
    assert.deepEqual(JSON.parse(tc.arguments), { path: '/x' });
});

test('parseDsmlInvoke: text mixed with parameters is rejected', () => {
    assert.equal(d.parseDsmlInvoke('read', 'oops<parameter name="p">1</parameter>'), null);
});

test('parseDsmlInvoke: an unclosed parameter is rejected', () => {
    assert.equal(d.parseDsmlInvoke('read', '<parameter name="p">1'), null);
});

test('parseDsmlToolCall: parses a wrapped invoke', () => {
    const tc = d.parseDsmlToolCall('<tool_calls><invoke name="read"><parameter name="path">/x</parameter></invoke></tool_calls>', () => {});
    assert.equal(tc.name, 'read');
    assert.deepEqual(JSON.parse(tc.arguments), { path: '/x' });
});

test('parseDsmlToolCall: parses a bare invoke without a wrapper', () => {
    const tc = d.parseDsmlToolCall('<invoke name="read"><parameter name="p">1</parameter></invoke>', () => {});
    assert.equal(tc.name, 'read');
});

test('parseDsmlToolCall: parses an open-ended <direct name=...> tag', () => {
    
    const tc = d.parseDsmlToolCall('<direct name="read"><parameter name="p">1</parameter>', () => {});
    assert.equal(tc.name, 'read');
    assert.deepEqual(JSON.parse(tc.arguments), { p: '1' });
});

test('parseDsmlToolCall: returns null when there is no markup', () => {
    assert.equal(d.parseDsmlToolCall('just prose', () => {}), null);
    assert.equal(d.parseDsmlToolCall('', () => {}), null);
});

test('parseDsmlToolCall: text outside the <tool_calls> wrapper is ignored', () => {
    
    const tc = d.parseDsmlToolCall('<tool_calls><invoke name="f"><parameter name="p">1</parameter></invoke></tool_calls> trailing', () => {});
    assert.equal(tc.name, 'f');
});

const P = '\uFF5C';

test('parseDsmlToolCall: duplicate wrapper openings are skipped', () => {
    const text = `<${P}DSML${P} calls>\n<${P}DSML${P} calls>\n<${P}DSML${P} invoke name="f">\n<${P}DSML${P} parameter name="a">1</${P}DSML${P} parameter>\n</${P}DSML${P} invoke>\n</${P}DSML${P} calls>`;
    const tc = d.parseDsmlToolCall(text, () => {});
    assert.equal(tc.name, 'f');
    assert.deepEqual(JSON.parse(tc.arguments), { a: '1' });
});

test('parseDsmlToolCall: a repeated closing parameter tag is ignored', () => {
    const text = `<${P}DSML${P} calls>\n<${P}DSML${P} invoke name="f">\n<${P}DSML${P} parameter name="a">1</${P}DSML${P} parameter>\n</${P}DSML${P} parameter>\n</${P}DSML${P} invoke>\n</${P}DSML${P} calls>`;
    const tc = d.parseDsmlToolCall(text, () => {});
    assert.deepEqual(JSON.parse(tc.arguments), { a: '1' });
});

test('parseDsmlToolCall: a nameless closing tag closes the parameter', () => {
    const text = `<${P}DSML${P} calls>\n<${P}DSML${P} invoke name="f">\n<${P}DSML${P} parameter name="code" string="true">x</${P}DSML${P}>\n</${P}DSML${P} invoke>\n</${P}DSML${P} calls>`;
    const tc = d.parseDsmlToolCall(text, () => {});
    assert.deepEqual(JSON.parse(tc.arguments), { code: 'x' });
});

test('parseDsmlToolCall: literal tags inside a code argument are raw text', () => {
    const text = `<${P}DSML${P} calls>\n<${P}DSML${P} invoke name="f">\n<${P}DSML${P} parameter name="code" string="true">see <${P}DSML${P} invoke name="g"> and </${P}DSML${P}> here</${P}DSML${P} parameter>\n</${P}DSML${P} invoke>\n</${P}DSML${P} calls>`;
    const tc = d.parseDsmlToolCall(text, () => {});
    assert.equal(tc.name, 'f');
    assert.deepEqual(JSON.parse(tc.arguments), { code: `see <invoke name="g"> and </${P}DSML${P}> here` });
});

test('parseDsmlToolCall: recovers a tool name from a leading name parameter', () => {
    
    const text = `<${P}DSML${P} calls>\n<${P}DSML${P} parameter name="name" string="true">f</${P}DSML${P} parameter>\n<${P}DSML${P} parameter name="a">1</${P}DSML${P} parameter>\n</${P}DSML${P} invoke>\n</${P}DSML${P} calls>`;
    const tc = d.parseDsmlToolCall(text, () => {});
    assert.equal(tc.name, 'f');
    assert.deepEqual(JSON.parse(tc.arguments), { a: '1' });
});

test('looksLikeToolCallMarkup: true for real tag forms', () => {
    assert.equal(d.looksLikeToolCallMarkup('<tool_call>...'), true);
    assert.equal(d.looksLikeToolCallMarkup('<invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('<|DSML| invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('<\uFF5CDSML invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('<DSML\uFF5C invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('<DSML invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('{"tool_call":{"name":"read"}}'), true);
});

test('looksLikeToolCallMarkup: false for prose that merely mentions DSML', () => {
    
    assert.equal(d.looksLikeToolCallMarkup('use `|DSML| calls` to invoke a tool'), false);
    assert.equal(d.looksLikeToolCallMarkup('plain text'), false);
    assert.equal(d.looksLikeToolCallMarkup(''), false);
});

test('looksLikeToolCallMarkup: ignores tag names quoted in inline code', () => {
    
    assert.equal(d.looksLikeToolCallMarkup('оборачиваются в `<tool_calls>` с тегами `<invoke>` / `<parameter>`'), false);
    assert.equal(d.looksLikeToolCallMarkup('use `<invoke name="read">` for a read'), false);
    
    assert.equal(d.looksLikeToolCallMarkup('<tool_calls>\n<invoke name="bash">\nsee `<invoke>` above'), true);
});

test('blankInlineCodeSpans: blanks single-backtick spans but not ``` fences', () => {
    assert.equal(d.blankInlineCodeSpans('a `b` c'), 'a     c');
    assert.equal(d.blankInlineCodeSpans('a ```json\n{}\n``` b'), 'a ```json\n{}\n``` b');
});

