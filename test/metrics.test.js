'use strict';
// Unit tests for lib/metrics.js. The counters are a tiny dependency-free
// singleton, so these tests only check the increment/snapshot contract that the
// /health report and the request path rely on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetrics, instance } = require('../lib/metrics');

test('createMetrics: starts at zero for every documented counter', () => {
    const m = createMetrics();
    assert.deepEqual(m.snapshot(), {
        requests: 0,
        completions: 0,
        toolCalls: 0,
        rotations: 0,
        upstreamTransient: 0,
        emptyResponses: 0,
    });
});

test('createMetrics: inc increments a known counter and ignores unknown names', () => {
    const m = createMetrics();
    m.inc('requests');
    m.inc('requests', 4);
    m.inc('not-a-counter', 100); // must be a no-op, not create a key
    const snap = m.snapshot();
    assert.equal(snap.requests, 5);
    assert.equal(Object.prototype.hasOwnProperty.call(snap, 'not-a-counter'), false);
});

test('createMetrics: snapshot returns a copy, so mutating it cannot corrupt the live counters', () => {
    const m = createMetrics();
    m.inc('completions');
    const snap = m.snapshot();
    snap.completions = 999;
    assert.equal(m.snapshot().completions, 1);
});

test('instance: the process-wide singleton is a usable metrics handle', () => {
    assert.equal(typeof instance.inc, 'function');
    assert.equal(typeof instance.snapshot, 'function');
    assert.equal(typeof instance.snapshot().requests, 'number');
});
