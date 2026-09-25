'use strict';
// Performance-budget checks for the tool-call parser.
//
// These are timing assertions and are inherently noisy on shared CI runners
// (and under V8 coverage instrumentation), so they are NOT part of the default
// `npm test` run. node --test discovers every *.js under test/ wholesale, so
// they live here instead and are run explicitly with `npm run test:perf`.
//
// The generators are copied from test/parser.extra.test.js so this file is
// self-contained.

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../lib/parser.js');

const silentLog = () => {};

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
function randInt(rng, min, max) { return min + Math.floor(rng() * (max - min + 1)); }
function randomString(rng, maxLen = 20) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.:/{}[]<>"\'\\|｜＜＞&;!@#$%^*()+=~`';
  const len = randInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}
// ===========================================================================
// 2. PERF BUDGETS
// ===========================================================================
function timeIt(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ms
}

// Timing tests are inherently noisy: CI runners and a busy developer machine
// can be several times slower than a warm local JIT. Warm up the function so
// the first (interpreted) run is not measured, then take the best of a few
// samples. The best run filters out scheduler/GC noise without hiding a true
// algorithmic regression (which would slow every sample).
//
// V8 coverage instrumentation (`NODE_V8_COVERAGE`, set by `--experimental-
// test-coverage` / `npm run test:coverage`) slows every function call down by
// roughly 2-3x, so the budgets are scaled by PERF_BUDGET_SCALE in that mode.
const PERF_BUDGET_SCALE = process.env.NODE_V8_COVERAGE ? 4 : 1;
const PERF_BUDGET = (ms) => ms * PERF_BUDGET_SCALE;

function bestOf(fn, samples = 7) {
  let best = Infinity;
  for (let i = 0; i < samples; i++) best = Math.min(best, fn());
  return best;
}

test('perf: parseToolCall on 1KB of garbage < 400ms for 1000 iterations', () => {
  const rng = makeRng(100);
  const inputs = Array.from({ length: 1000 }, () => randomString(rng, 1024));
  const run = () => timeIt(() => {
    for (const s of inputs) parser.parseToolCall(s, silentLog);
  }, 1);
  run(); // warm up
  const ms = bestOf(run);
  assert.ok(ms < PERF_BUDGET(400), `too slow: ${ms.toFixed(1)}ms`);
});

test('perf: parseToolCall on valid DSML < 200ms for 1000 iterations', () => {
  const text = '<tool_calls><invoke name="f"><parameter name="x">1</parameter></invoke></tool_calls>';
  const run = () => timeIt(() => parser.parseToolCall(text, silentLog), 1000);
  run(); // warm up
  const ms = bestOf(run);
  assert.ok(ms < PERF_BUDGET(200), `too slow: ${ms.toFixed(1)}ms`);
});

test('perf: extractBalancedJsonObjects on 10KB < 100ms for 100 iterations', () => {
  const rng = makeRng(101);
  const big = Array.from({ length: 100 }, () => JSON.stringify({ a: randomString(rng, 50) })).join('');
  const run = () => timeIt(() => parser.extractBalancedJsonObjects(big), 100);
  run(); // warm up
  const ms = bestOf(run);
  assert.ok(ms < PERF_BUDGET(100), `too slow: ${ms.toFixed(1)}ms`);
});

test('perf: normalizeToolMarkupTags on 10KB < 100ms for 100 iterations', () => {
  const rng = makeRng(102);
  const big = randomString(rng, 10240);
  const run = () => timeIt(() => parser.normalizeToolMarkupTags(big), 100);
  run(); // warm up
  const ms = bestOf(run);
  assert.ok(ms < PERF_BUDGET(100), `too slow: ${ms.toFixed(1)}ms`);
});

test('perf: no leak — 10k calls do not grow the heap > 50MB', () => {
  if (typeof global.gc === 'function') global.gc();
  const before = process.memoryUsage().heapUsed;
  const rng = makeRng(103);
  for (let i = 0; i < 10000; i++) {
    const s = randomString(rng, 200);
    parser.parseToolCall(s, silentLog);
  }
  if (typeof global.gc === 'function') global.gc();
  const after = process.memoryUsage().heapUsed;
  const deltaMb = (after - before) / (1024 * 1024);
  assert.ok(deltaMb < 50, `memory leak: +${deltaMb.toFixed(1)}MB`);
});

