// parser.fuzz.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../lib/parser.js');

const silentLog = () => {};

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — reproducible failures
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

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randomString(rng, maxLen = 20) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:/{}[]<>"\'\\|｜＜＞&;!@#$%^*()+=~`';
  const len = randInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Generators of "almost-valid" structures
// ---------------------------------------------------------------------------
const TOOL_NAMES = ['f', 'get_weather', 'a.b:c-d_e', 'x'.repeat(128), ' bad', ''];

function randomArgs(rng) {
  const kind = randInt(rng, 0, 4);
  switch (kind) {
    case 0: return {};
    case 1: return { a: 1, b: 'two', c: [1, 2, 3] };
    case 2: return { nested: { deep: { value: randInt(rng, 0, 100) } } };
    case 3: return { s: randomString(rng, 30) };
    case 4: return { 'ключ': 'значение', emoji: '🚀' };
  }
}

function randomJsonToolCall(rng, opts = {}) {
  const name = opts.name ?? pick(rng, TOOL_NAMES);
  const args = opts.args ?? randomArgs(rng);
  const style = randInt(rng, 0, 2);
  if (style === 0) return { tool_call: { name, arguments: args } };
  if (style === 1) return { function_call: { function: { name, arguments: JSON.stringify(args) } } };
  return { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] };
}

function randomDsmlToolCall(rng, opts = {}) {
  const name = opts.name ?? pick(rng, ['f', 'get_weather', 'a.b:c-d_e']);
  const params = [];
  const n = randInt(rng, 0, 3);
  for (let i = 0; i < n; i++) {
    const pname = `p${i}`;
    const stringMode = pick(rng, ['', ' string="true"', ' string="false"']);
    // With string="false" the parser must parse the body as JSON — generate
    // only valid JSON values, otherwise the input is knowingly invalid.
    const pval = stringMode === ' string="false"'
      ? pick(rng, ['1', 'true', 'false', 'null', '{"a":1}', '[1,2]', '"str"'])
      : pick(rng, ['1', 'hello', '{"a":1}', 'true', '']);
    params.push(`<parameter name="${pname}"${stringMode}>${pval}</parameter>`);
  }
  const inner = params.length
    ? params.join('')
    : JSON.stringify(randomArgs(rng));
  return `<tool_calls><invoke name="${name}">${inner}</invoke></tool_calls>`;
}

function randomToolCallMarkup(rng) {
  const kind = randInt(rng, 0, 3);
  switch (kind) {
    case 0: return randomDsmlToolCall(rng);
    case 1: return JSON.stringify(randomJsonToolCall(rng));
    case 2: return `<tool_call>${JSON.stringify({ name: 'f', arguments: randomArgs(rng) })}</tool_call>`;
    case 3: return '```json\n' + JSON.stringify(randomJsonToolCall(rng)) + '\n```';
  }
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------
function assertValidToolCallShape(tc) {
  assert.ok(tc && typeof tc === 'object', 'tool call must be an object');
  assert.equal(typeof tc.name, 'string');
  assert.match(tc.name, /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/);
  assert.equal(typeof tc.arguments, 'string');
  assert.ok(tc.arguments.length <= parser.MAX_TOOL_ARGUMENT_CHARS);
  // arguments is always a valid JSON object
  const parsed = JSON.parse(tc.arguments);
  assert.equal(typeof parsed, 'object');
  assert.ok(!Array.isArray(parsed));
  assert.ok(parsed !== null);
}

// ===========================================================================
// 1. Round-trip: a generated call must parse
// ===========================================================================
test('fuzz: JSON tool_call round-trip', () => {
  const rng = makeRng(1);
  let ok = 0;
  for (let i = 0; i < 500; i++) {
    const obj = randomJsonToolCall(rng, { name: 'f' });
    const tc = parser.parseToolCall(JSON.stringify(obj), silentLog);
    assert.ok(tc, `failed to parse: ${JSON.stringify(obj)}`);
    assertValidToolCallShape(tc);
    assert.equal(tc.name, 'f');
    ok++;
  }
  assert.equal(ok, 500);
});

test('fuzz: fenced JSON tool_call round-trip', () => {
  const rng = makeRng(2);
  for (let i = 0; i < 300; i++) {
    const obj = randomJsonToolCall(rng, { name: 'f' });
    const text = '```json\n' + JSON.stringify(obj) + '\n```';
    const tc = parser.parseToolCall(text, silentLog);
    assert.ok(tc, `failed to parse: ${text}`);
    assertValidToolCallShape(tc);
  }
});

test('fuzz: inline strict JSON round-trip', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 300; i++) {
    const name = pick(rng, ['f', 'get_weather', 'a-b_c']);
    const args = randomArgs(rng);
    const text = JSON.stringify({ tool_call: { name, arguments: args } });
    const tc = parser.parseToolCall(text, silentLog);
    assert.ok(tc, `failed to parse: ${text}`);
    assertValidToolCallShape(tc);
    assert.equal(tc.name, name);
    assert.deepEqual(JSON.parse(tc.arguments), args);
  }
});

test('fuzz: XML <tool_call> round-trip', () => {
  const rng = makeRng(4);
  for (let i = 0; i < 300; i++) {
    const name = pick(rng, ['f', 'get_weather']);
    const args = randomArgs(rng);
    const text = `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
    const tc = parser.parseToolCall(text, silentLog);
    assert.ok(tc, `failed to parse: ${text}`);
    assertValidToolCallShape(tc);
    assert.equal(tc.name, name);
  }
});

test('fuzz: DSML round-trip', () => {
  const rng = makeRng(5);
  for (let i = 0; i < 300; i++) {
    const text = randomDsmlToolCall(rng);
    const tc = parser.parseToolCall(text, silentLog);
    assert.ok(tc, `failed to parse: ${text}`);
    assertValidToolCallShape(tc);
  }
});

// ===========================================================================
// 2. Stability invariants: re-parsing yields the same result
// ===========================================================================
test('fuzz: parseToolCall idempotence', () => {
  const rng = makeRng(6);
  for (let i = 0; i < 300; i++) {
    const text = randomToolCallMarkup(rng);
    const a = parser.parseToolCall(text, silentLog);
    const b = parser.parseToolCall(text, silentLog);
    assert.deepEqual(a, b, `unstable: ${text}`);
  }
});

test('fuzz: extractBalancedJsonObjects idempotence', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 300; i++) {
    const text = randomString(rng, 200);
    const a = parser.extractBalancedJsonObjects(text);
    const b = parser.extractBalancedJsonObjects(text);
    assert.deepEqual(a, b);
  }
});

// ===========================================================================
// 3. Never throws on random input
// ===========================================================================
test('fuzz: parseToolCall does not throw on random strings', () => {
  const rng = makeRng(8);
  for (let i = 0; i < 2000; i++) {
    const s = randomString(rng, 500);
    assert.doesNotThrow(() => parser.parseToolCall(s, silentLog), `threw on: ${JSON.stringify(s)}`);
  }
});

test('fuzz: parseToolCall does not throw on random strings with DSML garbage', () => {
  const rng = makeRng(9);
  const pieces = ['<', '>', '/', '|', '｜', 'DSML', 'invoke', 'parameter', 'tool_calls', 'name="', '"', '\\', '{', '}', ' ', 'x', '<![CDATA[', ']]>'];
  for (let i = 0; i < 2000; i++) {
    let s = '';
    const n = randInt(rng, 0, 40);
    for (let j = 0; j < n; j++) s += pick(rng, pieces);
    assert.doesNotThrow(() => parser.parseToolCall(s, silentLog), `threw on: ${JSON.stringify(s)}`);
    assert.doesNotThrow(() => parser.parseDsmlToolCall(s, silentLog));
    assert.doesNotThrow(() => parser.hasUnclosedToolMarkup(s));
    assert.doesNotThrow(() => parser.looksLikeToolCallMarkup(s));
    assert.doesNotThrow(() => parser.normalizeToolMarkupTags(s));
    assert.doesNotThrow(() => parser.scanDsmlStructuralTags(s));
  }
});

test('fuzz: parseToolCall does not throw on random non-strings', () => {
  const rng = makeRng(10);
  const weird = [null, undefined, 0, 1, true, false, {}, [], () => {}, Symbol('x'), 123n];
  for (const v of weird) {
    assert.doesNotThrow(() => parser.parseToolCall(v, silentLog));
  }
  for (let i = 0; i < 100; i++) {
    const v = pick(rng, weird);
    assert.doesNotThrow(() => parser.parseToolCall(v, silentLog));
  }
});

// ===========================================================================
// 4. Limits are not violated
// ===========================================================================
test('fuzz: parseToolCall never returns args longer than the limit', () => {
  const rng = makeRng(11);
  for (let i = 0; i < 500; i++) {
    const s = randomString(rng, 1000);
    const tc = parser.parseToolCall(s, silentLog);
    if (tc) {
      assert.ok(tc.arguments.length <= parser.MAX_TOOL_ARGUMENT_CHARS);
    }
  }
});

test('fuzz: buildToolCall does not exceed the argument limit', () => {
  const rng = makeRng(12);
  for (let i = 0; i < 500; i++) {
    const size = randInt(rng, 0, parser.MAX_TOOL_ARGUMENT_CHARS + 100);
    const args = { a: 'x'.repeat(size) };
    const tc = parser.buildToolCall('f', args);
    if (tc) {
      assert.ok(tc.arguments.length <= parser.MAX_TOOL_ARGUMENT_CHARS);
    } else {
      // not fitting is expected
      assert.ok(JSON.stringify(args).length > parser.MAX_TOOL_ARGUMENT_CHARS - 10);
    }
  }
});

// ===========================================================================
// 5. Mutations: corrupting valid input must not break the parser
// ===========================================================================
function mutate(rng, s) {
  if (s.length === 0) return s;
  const pos = randInt(rng, 0, s.length - 1);
  const kind = randInt(rng, 0, 2);
  if (kind === 0) return s.slice(0, pos) + s.slice(pos + 1); // delete
  if (kind === 1) return s.slice(0, pos) + pick(rng, ['<', '>', '"', '\\', '{', '}', '|', '｜', ' ', '\0']) + s.slice(pos); // insert
  return s.slice(0, pos) + pick(rng, ['<', '>', '"', '\\', '{', '}', '|']) + s.slice(pos + 1); // replace
}

test('fuzz: mutations of valid calls do not break the parser', () => {
  const rng = makeRng(13);
  for (let i = 0; i < 2000; i++) {
    let s = randomToolCallMarkup(rng);
    const nMutations = randInt(rng, 1, 5);
    for (let j = 0; j < nMutations; j++) s = mutate(rng, s);
    assert.doesNotThrow(() => parser.parseToolCall(s, silentLog), `threw on: ${JSON.stringify(s)}`);
    // Anything returned must be valid
    const tc = parser.parseToolCall(s, silentLog);
    if (tc) assertValidToolCallShape(tc);
  }
});

// ===========================================================================
// 6. Consistency between looksLikeToolCallMarkup and hasUnclosedToolMarkup
// ===========================================================================
test('fuzz: hasUnclosedToolMarkup => looksLikeToolCallMarkup', () => {
  const rng = makeRng(14);
  for (let i = 0; i < 1000; i++) {
    const s = randomString(rng, 200);
    if (parser.hasUnclosedToolMarkup(s)) {
      assert.ok(parser.looksLikeToolCallMarkup(s), `inconsistency: ${JSON.stringify(s)}`);
    }
  }
});

// ===========================================================================
// 7. Normalization monotonicity: normalize(normalize(x)) == normalize(x)
// ===========================================================================
test('fuzz: normalizeToolMarkupTags is idempotent', () => {
  const rng = makeRng(15);
  for (let i = 0; i < 1000; i++) {
    const s = randomString(rng, 200);
    const once = parser.normalizeToolMarkupTags(s);
    const twice = parser.normalizeToolMarkupTags(once);
    assert.equal(twice, once, `not idempotent: ${JSON.stringify(s)}`);
  }
});

// ===========================================================================
// 8. decodeDsmlValue: does not increase length
// ===========================================================================
test('fuzz: decodeDsmlValue does not grow in length', () => {
  const rng = makeRng(16);
  for (let i = 0; i < 500; i++) {
    const s = randomString(rng, 100);
    const decoded = parser.decodeDsmlValue(s);
    assert.ok(decoded.length <= s.length, `decoding lengthened the string: ${JSON.stringify(s)} -> ${JSON.stringify(decoded)}`);
  }
});

// ===========================================================================
// 9. extractBalancedJsonAt is consistent with extractBalancedJsonObjects
//
// extractBalancedJsonObjects returns substrings whose braces balance (taking
// strings and escape sequences into account). This does NOT guarantee valid
// JSON — e.g. "{sL}" is balanced but not JSON. So we check extraction
// consistency instead: for every object found, extractBalancedJsonAt at its
// start position must return exactly the same substring.
// ===========================================================================
test('fuzz: extractBalancedJsonAt and extractBalancedJsonObjects are consistent', () => {
  const rng = makeRng(17);
  for (let i = 0; i < 1000; i++) {
    const s = randomString(rng, 200);
    const objs = parser.extractBalancedJsonObjects(s);
    let searchFrom = 0;
    for (const obj of objs) {
      assert.ok(obj.startsWith('{') && obj.endsWith('}'));
      const start = s.indexOf(obj, searchFrom);
      assert.ok(start >= 0, `not found in the source string: ${JSON.stringify(obj)}`);
      searchFrom = start + 1;
      const viaAt = parser.extractBalancedJsonAt(s, start);
      assert.equal(viaAt, obj, `mismatch: ${JSON.stringify(obj)} vs ${JSON.stringify(viaAt)}`);
      // If the substring is valid JSON, it must be an object.
      try {
        const parsed = JSON.parse(obj);
        assert.equal(typeof parsed, 'object');
        assert.ok(parsed !== null && !Array.isArray(parsed));
      } catch (_) { /* a balanced substring need not be valid JSON */ }
    }
  }
});

// ===========================================================================
// 10. parseToolCall: the returned object always has only name and arguments
// ===========================================================================
test('fuzz: parseToolCall returns only {name, arguments}', () => {
  const rng = makeRng(18);
  for (let i = 0; i < 1000; i++) {
    const s = randomToolCallMarkup(rng);
    const tc = parser.parseToolCall(s, silentLog);
    if (tc) {
      assert.deepEqual(Object.keys(tc).sort(), ['arguments', 'name']);
    }
  }
});