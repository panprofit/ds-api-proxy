'use strict';

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

    assert.equal(memoizeParse(state, 'unclosed', 'A', () => 'unclosed:A'), 'unclosed:A');
    assert.equal(memoizeParse(state, 'call', 'A', compute), 'parsed:A');
    assert.equal(calls, 1, 'a second key must not evict the first');

    assert.equal(memoizeParse(state, 'call', 'B', compute), 'parsed:B');
    assert.equal(calls, 2, 'changed content must recompute');

    assert.equal(memoizeParse(state, 'call', 'A', compute), 'parsed:A');
    assert.equal(calls, 3);
});

test('memoizeParse: stores results on state.parseMemo', () => {
    const state = {};
    memoizeParse(state, 'call', 'x', () => 42);
    assert.ok(state.parseMemo);
    assert.deepEqual(state.parseMemo.call, { content: 'x', value: 42 });
});
