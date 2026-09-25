'use strict';
// Unit tests for lib/openai.js (token estimation, response builders, chunking).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    TOKEN_CHARS,
    isCjkCodePoint,
    countTokenClasses,
    estimateTokens,
    buildUsageFromTokens,
    buildToolCallResponseFromTokens,
    buildTextResponseFromTokens,
    splitIntoChunks,
    STREAM_CHUNK_CODE_POINTS,
} = require('../lib/openai');

test('estimateTokens: empty input -> 0', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens: ASCII is roughly length/4, rounded up', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
});

test('estimateTokens: non-ASCII chars are weighted heavier', () => {
    assert.ok(estimateTokens('абвг') > estimateTokens('aaaa'));
});

test('estimateTokens: CJK is weighted denser than Cyrillic', () => {
    // 4 identical-length strings: ASCII < Cyrillic < CJK token counts.
    const ascii = estimateTokens('abcd');
    const cyrillic = estimateTokens('абвг');
    const cjk = estimateTokens('汉字测试');
    assert.ok(cyrillic >= ascii);
    assert.ok(cjk >= cyrillic);
});

test('estimateTokens: non-empty input never returns 0', () => {
    assert.equal(estimateTokens('a'), 1);
    assert.equal(estimateTokens('\u00e9'), 1);
    assert.equal(estimateTokens('\u6c49'), 1);
    assert.equal(estimateTokens('\u{1F600}'), 2);
});

test('estimateTokens: astral code points count as surrogate pairs', () => {
    // Each astral emoji is 2 JS units / 2 tokens; 3 emoji -> 6 tokens.
    assert.equal(estimateTokens('\u{1F600}\u{1F600}\u{1F600}'), 6);
});

test('countTokenClasses: splits text by token class', () => {
    const counts = countTokenClasses('ab\u00e9\u6c49\u{1F600}');
    assert.equal(counts.ascii, 2);   // a b
    assert.equal(counts.wide, 1);    // é
    assert.equal(counts.cjk, 1);     // 汉
    assert.equal(counts.astral, 1);  // 😀
});

test('isCjkCodePoint: true for Han/Hiragana/Hangul, false for Latin/Cyrillic', () => {
    assert.equal(isCjkCodePoint('\u6c49'.codePointAt(0)), true);
    assert.equal(isCjkCodePoint('\u3042'.codePointAt(0)), true); // あ
    assert.equal(isCjkCodePoint('\uac00'.codePointAt(0)), true); // 가
    assert.equal(isCjkCodePoint('A'.codePointAt(0)), false);
    assert.equal(isCjkCodePoint('\u0430'.codePointAt(0)), false); // Cyrillic 'а'
});

test('TOKEN_CHARS: ASCII is the loosest class', () => {
    assert.ok(TOKEN_CHARS.ascii > TOKEN_CHARS.wide);
    assert.ok(TOKEN_CHARS.wide > TOKEN_CHARS.cjk);
});

test('buildUsageFromTokens: prompt side is used verbatim as a token count', () => {
    const usage = buildUsageFromTokens(12345, 'abcd');
    assert.equal(usage.prompt_tokens, 12345);
    assert.equal(usage.completion_tokens, 1);
    assert.equal(usage.total_tokens, 12346);
});

test('buildUsageFromTokens: reasoning tokens fold into completion tokens', () => {
    const usage = buildUsageFromTokens(100, '', 'efgh');
    assert.equal(usage.prompt_tokens, 100);
    assert.equal(usage.completion_tokens, 1);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, 1);
});

test('buildTextResponseFromTokens: reports the accumulated prompt token count', () => {
    const resp = buildTextResponseFromTokens('hello', 4096, 'why');
    assert.equal(resp.choices[0].message.content, 'hello');
    assert.equal(resp.choices[0].message.reasoning_content, 'why');
    assert.equal(resp.usage.prompt_tokens, 4096);
    assert.equal(resp.usage.total_tokens, 4096 + resp.usage.completion_tokens);
});

test('buildTextResponseFromTokens: length finish reason is preserved', () => {
    assert.equal(buildTextResponseFromTokens('x', 10, '', 'length').choices[0].finish_reason, 'length');
});

test('buildToolCallResponseFromTokens: reports the accumulated prompt token count', () => {
    const resp = buildToolCallResponseFromTokens({ name: 'read', arguments: '{}' }, 2048, 'r');
    assert.equal(resp.choices[0].finish_reason, 'tool_calls');
    assert.equal(resp.usage.prompt_tokens, 2048);
    assert.equal(resp.choices[0].message.tool_calls[0].function.name, 'read');
});

test('splitIntoChunks: empty input -> []', () => {
    assert.deepEqual(splitIntoChunks(''), []);
    assert.deepEqual(splitIntoChunks(null), []);
});

test('splitIntoChunks: splits by code points, preserving astral chars', () => {
    const text = 'a'.repeat(STREAM_CHUNK_CODE_POINTS) + '\u{1F600}' + 'b';
    const chunks = splitIntoChunks(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[chunks.length - 1].includes('\u{1F600}'));
});

test('splitIntoChunks: honours a custom size', () => {
    assert.deepEqual(splitIntoChunks('abcdef', 2), ['ab', 'cd', 'ef']);
});

test('STREAM_CHUNK_CODE_POINTS is a positive integer', () => {
    assert.ok(Number.isInteger(STREAM_CHUNK_CODE_POINTS) && STREAM_CHUNK_CODE_POINTS > 0);
});
