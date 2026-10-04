'use strict';
// Direct unit tests for lib/parser-native.js: DeepSeek's native
// `<|tool▁calls▁begin|> … <|tool▁calls▁end|>` marker grammar.

const test = require('node:test');
const assert = require('node:assert/strict');

const n = require('../lib/parser-native');

const M = n.TOOL_CALL_START; // <|tool\u2581calls\u2581begin|>
const E = n.TOOL_CALL_END;   // <|tool\u2581calls\u2581end|>

// --- fuzzy character equivalence -------------------------------------------

test('normTagChar: folds the fullwidth pipe and the U+2581 separator', () => {
    assert.equal(n.normTagChar('\uFF5C'), '|');
    assert.equal(n.normTagChar('\u2581'), '_');
    assert.equal(n.normTagChar('a'), 'a');
});

test('eqTagChar: treats U+FF5C/U+2581 variants as equal to ASCII', () => {
    assert.equal(n.eqTagChar('\uFF5C', '|'), true);
    assert.equal(n.eqTagChar('\u2581', '_'), true);
    assert.equal(n.eqTagChar('a', 'b'), false);
});

// --- marker detection -------------------------------------------------------

test('looksLikeNativeMarker: true for the canonical open/close markers', () => {
    assert.equal(n.looksLikeNativeMarker(M), true);
    assert.equal(n.looksLikeNativeMarker(E), true);
});

test('looksLikeNativeMarker: true when the separators are hallucinated', () => {
    // ASCII underscore instead of U+2581, fullwidth pipe instead of ASCII.
    assert.equal(n.looksLikeNativeMarker('<|tool_calls_begin|>'), true);
    assert.equal(n.looksLikeNativeMarker('<\uFF5Ctool\u2581calls\u2581begin\uFF5C>'), true);
});

test('looksLikeNativeMarker: false without an angle bracket or marker body', () => {
    assert.equal(n.looksLikeNativeMarker('tool_calls_begin'), false);
    assert.equal(n.looksLikeNativeMarker('plain text'), false);
    assert.equal(n.looksLikeNativeMarker(''), false);
});

test('containsNativeMarker: finds the opening marker anywhere in the text', () => {
    assert.equal(n.containsNativeMarker(`prefix ${M} [{}] ${E}`), true);
    assert.equal(n.containsNativeMarker('no marker here'), false);
});

// --- parsing ----------------------------------------------------------------

test('parseNativeToolCalls: parses a JSON array of calls', () => {
    const body = JSON.stringify([{ name: 'get_weather', arguments: { city: '\u5317\u4eac' } }]);
    const tc = n.parseNativeToolCalls(M + body + E);
    assert.deepEqual(tc, { name: 'get_weather', arguments: '{"city":"\u5317\u4eac"}' });
});

test('parseNativeToolCalls: parses a single bare object', () => {
    const body = JSON.stringify({ name: 'Bash', arguments: { command: 'ls' } });
    const tc = n.parseNativeToolCalls(M + body + E);
    assert.deepEqual(tc, { name: 'Bash', arguments: '{"command":"ls"}' });
});

test('parseNativeToolCalls: fuzzy-matches a hallucinated closing marker', () => {
    const body = JSON.stringify([{ name: 'get_weather', arguments: {} }]);
    const malformed = M + body + '<|tool_calls\u2581end\uFF5C>';
    const tc = n.parseNativeToolCalls(malformed);
    assert.equal(tc.name, 'get_weather');
});

test('parseNativeToolCalls: tolerates surrounding prose', () => {
    const body = JSON.stringify([{ name: 'f', arguments: { a: 1 } }]);
    const tc = n.parseNativeToolCalls(`Here is the call:\n${M}${body}${E}\ndone`);
    assert.equal(tc.name, 'f');
});

test('parseNativeToolCalls: null without a marker', () => {
    assert.equal(n.parseNativeToolCalls(JSON.stringify([{ name: 'f', arguments: {} }])), null);
    assert.equal(n.parseNativeToolCalls(''), null);
});

test('parseNativeToolCalls: null for an empty array', () => {
    assert.equal(n.parseNativeToolCalls(M + '[]' + E), null);
});

test('parseNativeToolCalls: ignores a marker inside a code fence', () => {
    const body = JSON.stringify([{ name: 'f', arguments: {} }]);
    const fenced = 'example:\n```json\n' + M + body + E + '\n```';
    assert.equal(n.parseNativeToolCalls(fenced), null);
});

test('parseNativeToolCalls: null for a truncated body', () => {
    const body = JSON.stringify([{ name: 'f', arguments: { a: 1 } }]);
    // Cut the array before its closing brace/bracket so nothing balances.
    assert.equal(n.parseNativeToolCalls(M + body.slice(0, body.length - 3)), null);
});

// --- integration with the top-level parser ----------------------------------

test('parseToolCall: routes the native marker grammar to parser-native', () => {
    const { parseToolCall } = require('../lib/parser');
    const body = JSON.stringify([{ name: 'get_weather', arguments: { city: '\u5317\u4eac' } }]);
    const tc = parseToolCall(M + body + E, () => {});
    assert.deepEqual(tc, { name: 'get_weather', arguments: '{"city":"\u5317\u4eac"}' });
});

test('looksLikeToolCallMarkup: native marker counts as tool markup', () => {
    const { looksLikeToolCallMarkup } = require('../lib/parser');
    assert.equal(looksLikeToolCallMarkup(M), true);
});

test('hasUnclosedToolMarkup: truncated native markup is reported as unclosed', () => {
    const { hasUnclosedToolMarkup } = require('../lib/parser');
    const body = JSON.stringify([{ name: 'f', arguments: { a: 1 } }]);
    assert.equal(hasUnclosedToolMarkup(M + body.slice(0, body.length - 3)), true);
});

test('hasUnclosedToolMarkup: a complete native call is not unclosed', () => {
    const { hasUnclosedToolMarkup } = require('../lib/parser');
    const body = JSON.stringify([{ name: 'f', arguments: { a: 1 } }]);
    assert.equal(hasUnclosedToolMarkup(M + body + E), false);
});
