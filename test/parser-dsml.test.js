'use strict';
// Direct unit tests for lib/parser-dsml.js: tag canonicalization, structural
// scanning, attribute/value decoding and the <invoke>/<parameter> grammar.
// Previously these functions had no dedicated file (only indirect coverage).

const test = require('node:test');
const assert = require('node:assert/strict');

const d = require('../lib/parser-dsml');

// --- canonicalizeToolMarkupTag ---------------------------------------------

test('canonicalizeToolMarkupTag: normalizes the DSML pipe form', () => {
    assert.equal(d.canonicalizeToolMarkupTag('|DSML| invoke name="f"'), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag('/|DSML| tool_calls'), '</tool_calls>');
});

test('canonicalizeToolMarkupTag: maps the `calls` short wrapper to tool_calls', () => {
    assert.equal(d.canonicalizeToolMarkupTag('calls'), '<tool_calls>');
    assert.equal(d.canonicalizeToolMarkupTag('/calls'), '</tool_calls>');
});

test('canonicalizeToolMarkupTag: smart quotes / fullwidth are folded to ASCII', () => {
    assert.match(d.canonicalizeToolMarkupTag('invoke name=“f”'), /^<invoke name="f">$/);
});

test('canonicalizeToolMarkupTag: `name=` becomes a <direct> tag', () => {
    assert.equal(d.canonicalizeToolMarkupTag('name="read"'), '<direct name="read">');
});

test('canonicalizeToolMarkupTag: non-semantic tags return null', () => {
    assert.equal(d.canonicalizeToolMarkupTag('div class="x"'), null);
    assert.equal(d.canonicalizeToolMarkupTag(''), null);
});

// --- normalizeToolMarkupTags -----------------------------------------------

test('normalizeToolMarkupTags: rewrites known tags and leaves others verbatim', () => {
    const out = d.normalizeToolMarkupTags('a ＜|DSML| invoke name="f"> b <div> c');
    assert.match(out, /<invoke name="f">/);
    assert.match(out, /<div>/, 'unrecognized tags are preserved');
    assert.ok(!out.includes('＜'), 'fullwidth angle brackets are folded to ASCII');
});

// --- decodeDsmlValue / decodeDsmlParameterValue ----------------------------

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

// --- getMarkupAttribute ----------------------------------------------------

test('getMarkupAttribute: reads single- and double-quoted values', () => {
    assert.equal(d.getMarkupAttribute('name="read" other="x"', 'name'), 'read');
    assert.equal(d.getMarkupAttribute("name='read'", 'name'), 'read');
});

test('getMarkupAttribute: missing attribute returns null', () => {
    assert.equal(d.getMarkupAttribute('name="read"', 'string'), null);
    assert.equal(d.getMarkupAttribute('', 'name'), null);
});

// --- readDsmlTagAt ---------------------------------------------------------

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

// --- scanDsmlStructuralTags ------------------------------------------------

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

// --- parseDsmlParameter ----------------------------------------------------

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

// --- parseDsmlInvoke -------------------------------------------------------

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

// --- parseDsmlToolCall -----------------------------------------------------

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
    // <direct> has no closing tag; the body is everything after the tag.
    const tc = d.parseDsmlToolCall('<direct name="read"><parameter name="p">1</parameter>', () => {});
    assert.equal(tc.name, 'read');
    assert.deepEqual(JSON.parse(tc.arguments), { p: '1' });
});

test('parseDsmlToolCall: returns null when there is no markup', () => {
    assert.equal(d.parseDsmlToolCall('just prose', () => {}), null);
    assert.equal(d.parseDsmlToolCall('', () => {}), null);
});

test('parseDsmlToolCall: text outside the <tool_calls> wrapper is ignored', () => {
    // extractToolCallScope returns only the wrapper's inner text, so anything
    // after </tool_calls> does not affect the parse.
    const tc = d.parseDsmlToolCall('<tool_calls><invoke name="f"><parameter name="p">1</parameter></invoke></tool_calls> trailing', () => {});
    assert.equal(tc.name, 'f');
});

// --- looksLikeToolCallMarkup -----------------------------------------------

test('looksLikeToolCallMarkup: true for real tag forms', () => {
    assert.equal(d.looksLikeToolCallMarkup('<tool_call>...'), true);
    assert.equal(d.looksLikeToolCallMarkup('<invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('<|DSML| invoke name="f">'), true);
    assert.equal(d.looksLikeToolCallMarkup('{"tool_call":{"name":"read"}}'), true);
});

test('looksLikeToolCallMarkup: false for prose that merely mentions DSML', () => {
    // Regression: a backticked `|DSML| calls` in prose must NOT trigger markup
    // recovery (no `<`/`＜` tag form is present).
    assert.equal(d.looksLikeToolCallMarkup('use `|DSML| calls` to invoke a tool'), false);
    assert.equal(d.looksLikeToolCallMarkup('plain text'), false);
    assert.equal(d.looksLikeToolCallMarkup(''), false);
});
