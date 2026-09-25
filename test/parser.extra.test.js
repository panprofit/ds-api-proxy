// parser.extra.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../lib/parser.js');

const silentLog = () => {};

// ---------------------------------------------------------------------------
// PRNG and generators (same as in parser.fuzz.test.js — copied for self-containment)
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }
function randomString(rng, maxLen = 20) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:/{}[]<>"\'\\|｜＜＞&;!@#$%^*()+=~`';
  const len = randInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}
function randomArgs(rng) {
  const kind = randInt(rng, 0, 4);
  switch (kind) {
    case 0: return {};
    case 1: return { a: 1, b: 'two', c: [1, 2, 3] };
    case 2: return { nested: { deep: { value: randInt(rng, 0, 100) } } };
    case 3: return { s: randomString(rng, 30) };
    case 4: return { 'key': 'value', emoji: '🚀' };
  }
}
function randomToolCallMarkup(rng) {
  const kind = randInt(rng, 0, 3);
  const name = pick(rng, ['f', 'get_weather', 'a.b:c-d_e']);
  const args = randomArgs(rng);
  switch (kind) {
    case 0: return `<tool_calls><invoke name="${name}"><parameter name="x">1</parameter></invoke></tool_calls>`;
    case 1: return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
    case 2: return '```json\n' + JSON.stringify({ tool_call: { name, arguments: args } }) + '\n```';
    case 3: return JSON.stringify({ tool_call: { name, arguments: args } });
  }
}

// ===========================================================================
// 1. SMOKE MATRIX: 50 different seeds
// ===========================================================================
test('smoke matrix: 50 seeds × 200 iterations do not break parseToolCall', () => {
  const seeds = Array.from({ length: 50 }, (_, i) => i + 1);
  let totalParsed = 0;
  let totalCalls = 0;
  for (const seed of seeds) {
    const rng = makeRng(seed);
    for (let i = 0; i < 200; i++) {
      const s = randomToolCallMarkup(rng);
      const tc = parser.parseToolCall(s, silentLog);
      totalCalls++;
      if (tc) {
        totalParsed++;
        assert.equal(typeof tc.name, 'string');
        assert.equal(typeof tc.arguments, 'string');
        assert.doesNotThrow(() => JSON.parse(tc.arguments));
      }
    }
  }
  // The vast majority of generated calls must parse.
  assert.ok(totalParsed / totalCalls > 0.9, `parsed ${totalParsed}/${totalCalls}`);
});

test('smoke matrix: 50 seeds × 100 iterations of random garbage do not throw', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const rng = makeRng(seed * 31);
    for (let i = 0; i < 100; i++) {
      const s = randomString(rng, 500);
      assert.doesNotThrow(() => parser.parseToolCall(s, silentLog));
    }
  }
});

// ===========================================================================
// 3. "EVIL" UNICODE EDGE CASES
// ===========================================================================
const EVIL_CHARS = [
  '\u2028', // LINE SEPARATOR
  '\u2029', // PARAGRAPH SEPARATOR
  '\u200B', // ZERO WIDTH SPACE
  '\u200C', // ZERO WIDTH NON-JOINER
  '\u200D', // ZERO WIDTH JOINER
  '\uFEFF', // BOM
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', // RTL/LTR overrides
  '\u2066', '\u2067', '\u2068', '\u2069', // isolates
  '\uD800', '\uDFFF', // lone surrogates
  '\uFFFD', // replacement char
  '\u3000', // ideographic space
  '\u00A0', // NBSP
  '\u0000', // NUL
  '\u0007', // BEL
  '\u001B', // ESC
];

test('unicode: parseToolCall does not throw on each evil char', () => {
  for (const ch of EVIL_CHARS) {
    const inputs = [
      ch,
      `<tool_call>${ch}{"name":"f"}</tool_call>`,
      `<tool_calls>${ch}<invoke name="f"></invoke></tool_calls>`,
      `{"tool_call":{"name":"f${ch}","arguments":{}}}`,
      `${ch}${ch}${ch}`,
    ];
    for (const s of inputs) {
      assert.doesNotThrow(
        () => parser.parseToolCall(s, silentLog),
        `threw on ${JSON.stringify(s)}`,
      );
      assert.doesNotThrow(() => parser.normalizeToolMarkupTags(s));
      assert.doesNotThrow(() => parser.hasUnclosedToolMarkup(s));
      assert.doesNotThrow(() => parser.looksLikeToolCallMarkup(s));
    }
  }
});

test('unicode: evil chars do not pass tool-name validation', () => {
  for (const ch of EVIL_CHARS) {
    if (ch === '\u0000') continue;
    const tc = parser.buildToolCall(`f${ch}`, {});
    if (ch.trim() === '') {
      // whitespace stripped by trim() -> name normalizes to 'f'
      assert.ok(tc, `whitespace ${JSON.stringify(ch)} must be trimmed`);
      assert.equal(tc.name, 'f');
    } else {
      assert.equal(tc, null, `name with ${JSON.stringify(ch)} was accepted`);
    }
  }
});

test('unicode: evil chars in arguments are preserved verbatim', () => {
  for (const ch of EVIL_CHARS) {
    const tc = parser.buildToolCall('f', { v: ch });
    assert.ok(tc, `failed to build with ${JSON.stringify(ch)}`);
    assert.equal(JSON.parse(tc.arguments).v, ch);
  }
});

test('unicode: RTL-override does not break the JSON extractor', () => {
  const rtl = '\u202E';
  const text = `prefix ${rtl}{"a":1}${rtl} suffix`;
  const objs = parser.extractBalancedJsonObjects(text);
  assert.deepEqual(objs, ['{"a":1}']);
});

test('unicode: surrogate pairs in arguments', () => {
  const emoji = '🚀🎉👨‍👩‍👧‍👦';
  const tc = parser.buildToolCall('f', { e: emoji });
  assert.ok(tc);
  assert.equal(JSON.parse(tc.arguments).e, emoji);
});

test('unicode: parseToolCall does not throw on each evil char in 1KB of garbage', () => {
  const rng = makeRng(200);
  for (const ch of EVIL_CHARS) {
    for (let i = 0; i < 20; i++) {
      const noise = randomString(rng, 200);
      const s = noise + ch.repeat(50) + noise;
      assert.doesNotThrow(() => parser.parseToolCall(s, silentLog));
    }
  }
});

// ===========================================================================
// 4. EXTRA BOUNDARIES
// ===========================================================================
test('boundaries: exactly MAX_TOOL_MARKUP_CHARS is accepted', () => {
  const filler = 'x'.repeat(parser.MAX_TOOL_MARKUP_CHARS - 100);
  const text = filler + '{"tool_call":{"name":"f","arguments":{"a":1}}}';
  assert.ok(text.length <= parser.MAX_TOOL_MARKUP_CHARS);
  const tc = parser.parseToolCall(text, silentLog);
  assert.ok(tc);
});

test('boundaries: MAX_TOOL_MARKUP_CHARS + 1 is rejected', () => {
  const text = 'x'.repeat(parser.MAX_TOOL_MARKUP_CHARS + 1);
  assert.equal(parser.parseToolCall(text, silentLog), null);
});

test('boundaries: exactly MAX_TOOL_ARGUMENT_CHARS of arguments', () => {
  const target = parser.MAX_TOOL_ARGUMENT_CHARS;
  // Size the string so that JSON.stringify yields exactly `target`.
  const prefix = '{"a":"';
  const suffix = '"}';
  const fillerLen = target - prefix.length - suffix.length;
  const args = { a: 'x'.repeat(fillerLen) };
  const serialized = JSON.stringify(args);
  assert.equal(serialized.length, target);
  const tc = parser.buildToolCall('f', args);
  assert.ok(tc);
  assert.equal(tc.arguments.length, target);
});

test('boundaries: MAX_TOOL_ARGUMENT_CHARS + 1 of arguments is rejected', () => {
  const target = parser.MAX_TOOL_ARGUMENT_CHARS + 1;
  const prefix = '{"a":"';
  const suffix = '"}';
  const fillerLen = target - prefix.length - suffix.length;
  const args = { a: 'x'.repeat(fillerLen) };
  assert.equal(JSON.stringify(args).length, target);
  assert.equal(parser.buildToolCall('f', args), null);
});

test('boundaries: name of exactly 128 chars is accepted', () => {
  const name = 'a'.repeat(128);
  assert.ok(parser.buildToolCall(name, {}));
});

test('boundaries: name of 129 chars is rejected', () => {
  assert.equal(parser.buildToolCall('a'.repeat(129), {}), null);
});