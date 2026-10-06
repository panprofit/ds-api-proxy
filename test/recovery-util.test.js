'use strict';
// Tests for lib/recovery-util.js: retry-delay math and the memoizeParse
// helper that lets the recovery phases avoid re-parsing the same tool markup.

const test = require('node:test');
const assert = require('node:assert/strict');

const { memoizeParse } = require('../lib/recovery-util');

test('memoizeParse: caches per content and key, recomputes on content change', () => {
    const state = {};
    let calls = 0;
    const compute = (content) => { calls++; return `parsed:${content}`; };

    assert.equal(memoizeParse(state, 'call', 'A', compute), 'parsed:A');
    assert.equal(memoizeParse(state, 'call', 'A', compute), 'parsed:A');
    assert.equal(calls, 1, 'same content+key must not recompute');

    // A different key is a different computation on the same content.
    assert.equal(memoizeParse(state, 'unclosed', 'A', () => 'unclosed:A'), 'unclosed:A');
    assert.equal(memoizeParse(state, 'call', 'A', compute), 'parsed:A');
    assert.equal(calls, 1, 'a second key must not evict the first');

    // Changed content invalidates the slot (completion rounds append).
    assert.equal(memoizeParse(state, 'call', 'B', compute), 'parsed:B');
    assert.equal(calls, 2, 'changed content must recompute');

    // And going back to the old content recomputes (single-slot cache).
    assert.equal(memoizeParse(state, 'call', 'A', compute), 'parsed:A');
    assert.equal(calls, 3);
});

test('memoizeParse: stores results on state.parseMemo', () => {
    const state = {};
    memoizeParse(state, 'call', 'x', () => 42);
    assert.ok(state.parseMemo);
    assert.deepEqual(state.parseMemo.call, { content: 'x', value: 42 });
});
