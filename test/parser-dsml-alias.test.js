'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const d = require('../lib/parser-dsml');

const PIPE = '｜';

test('canonicalizeToolMarkupTag: maps the tool_ prefixed tag aliases', () => {
    assert.equal(d.canonicalizeToolMarkupTag('tool_invoke name="f"'), '<invoke name="f">');
    assert.equal(d.canonicalizeToolMarkupTag('/tool_invoke'), '</invoke>');
    assert.equal(d.canonicalizeToolMarkupTag('tool_param name="a"'), '<parameter name="a">');
    assert.equal(d.canonicalizeToolMarkupTag('/tool_param'), '</parameter>');
});

test('canonicalizeToolMarkupTag: accepts a lone pipe in front of a tag name', () => {
    assert.equal(d.canonicalizeToolMarkupTag(`${PIPE}tool_call`), '<tool_calls>');
    assert.equal(d.canonicalizeToolMarkupTag(`/${PIPE}tool_call`), '</tool_calls>');
    assert.equal(d.canonicalizeToolMarkupTag(`${PIPE}tool_invoke name="f"`), '<invoke name="f">');
});

test('parseDsmlToolCall: parses the tool_invoke/tool_param alias dialect', () => {
    const text = `<${PIPE}tool_call>
<${PIPE}tool_invoke name="bash">
<tool_param name="command">ls</tool_param>
</${PIPE}tool_invoke>
</${PIPE}tool_call>`;
    const call = d.parseDsmlToolCall(text, () => {});
    assert.ok(call);
    assert.equal(call.name, 'bash');
    assert.deepEqual(JSON.parse(call.arguments), { command: 'ls' });
});

test('looksLikeTaggedToolMarkup: recognizes the tool_invoke alias', () => {
    assert.ok(d.looksLikeTaggedToolMarkup(`<${PIPE}tool_call>
<${PIPE}tool_invoke name="bash">`));
});
