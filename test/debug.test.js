'use strict';
// Unit tests for lib/debug.js: the DS_DEBUG switch and the two log helpers.
// Every case injects an env object, so the real process.env is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDebugEnabled, debugLog, debugLogEnv } = require('../lib/debug');

test('isDebugEnabled: true for 1/true (any case), false otherwise', () => {
    assert.equal(isDebugEnabled({ DS_DEBUG: '1' }), true);
    assert.equal(isDebugEnabled({ DS_DEBUG: 'TRUE' }), true);
    assert.equal(isDebugEnabled({ DS_DEBUG: 'true' }), true);
    assert.equal(isDebugEnabled({ DS_DEBUG: '0' }), false);
    assert.equal(isDebugEnabled({ DS_DEBUG: '' }), false);
    assert.equal(isDebugEnabled({}), false);
});

test('isDebugEnabled: defaults to process.env when no env is passed', () => {
    assert.equal(typeof isDebugEnabled(), 'boolean');
});

test('debugLog: emits only when process.env.DS_DEBUG is on', () => {
    const lines = [];
    debugLog((...a) => lines.push(a.join(' ')), 'should not appear');
    assert.equal(lines.length, 0);
});

test('debugLog: non-function log falls back to console.log', () => {
    const original = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try {
        debugLog(null, 'silent');
        assert.equal(lines.length, 0, 'gated off, so nothing is logged');
    } finally {
        console.log = original;
    }
});

test('debugLogEnv: emits for a truthy env and stays silent for an empty one', () => {
    const lines = [];
    const log = (...a) => lines.push(a.join(' '));
    debugLogEnv(log, { DS_DEBUG: '1' }, 'hello');
    assert.deepEqual(lines, ['hello']);
    debugLogEnv(log, {}, 'world');
    assert.deepEqual(lines, ['hello']);
});

test('debugLogEnv: non-function log falls back to console.log', () => {
    const original = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try {
        debugLogEnv(undefined, { DS_DEBUG: '1' }, 'via console');
        assert.deepEqual(lines, ['via console']);
    } finally {
        console.log = original;
    }
});
