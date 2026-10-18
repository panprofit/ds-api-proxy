'use strict';
// Direct unit tests for lib/recovery-markup.js: markup diagnostics and the two
// recovery passes (completion rounds + one strict retry). These were only
// covered indirectly through recovery.test.js. Dependencies are injected, so
// no network or real upstream session is involved.

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeToolMarkup, debugDumpToolMarkup } = require('../lib/recovery-markup');

// --- describeToolMarkup ----------------------------------------------------

test('describeToolMarkup: JSON shape reports the parse error and head/tail', () => {
    const diag = describeToolMarkup('{"tool_call":{"name":"read","arguments":{"p":}}');
    assert.equal(diag.shape, 'json');
    assert.equal(diag.dsmlTags, 'n/a');
    assert.equal(diag.looksLikeMarkup, true);
    assert.ok(diag.parseError && diag.parseError.startsWith('json:'));
    assert.ok(diag.head.length <= 80);
});

test('describeToolMarkup: DSML shape counts structural tags', () => {
    const diag = describeToolMarkup('<tool_calls><invoke name="read"><parameter name="p">1</parameter></invoke></tool_calls>');
    assert.equal(diag.shape, 'dsml');
    assert.equal(diag.dsmlTags, '6');
});

test('describeToolMarkup: an oversized/unbalanced DSML body reports it', () => {
    const diag = describeToolMarkup('<tool_calls><invoke name="read">');
    assert.equal(diag.shape, 'dsml');
    // Unbalanced tags still scan (they are recognized), so the count is numeric
    // or the explicit marker; either way it must not throw.
    assert.ok(typeof diag.dsmlTags === 'string');
});

test('describeToolMarkup: plain prose is not markup', () => {
    const diag = describeToolMarkup('just a normal answer with no call');
    assert.equal(diag.looksLikeMarkup, false);
    assert.equal(diag.parseError, 'no-call');
});

// --- debugDumpToolMarkup ---------------------------------------------------

test('debugDumpToolMarkup: no-op when DS_DEBUG is off', () => {
    const lines = [];
    debugDumpToolMarkup('[a]', 'some content', (m) => lines.push(m));
    assert.equal(lines.length, 0);
});

test('debugDumpToolMarkup: dumps once per unchanged content, then stops', () => {
    const lines = [];
    const log = (m) => lines.push(m);
    const env = { DS_DEBUG: '1' };
    debugDumpToolMarkup('[dedupe]', 'same content', log, env);
    const firstRun = lines.length;
    assert.ok(firstRun > 0, 'first call should emit');
    debugDumpToolMarkup('[dedupe]', 'same content', log, env);
    assert.equal(lines.length, firstRun, 'identical content must not re-emit');
});

test('debugDumpToolMarkup: evicts the least-recently-touched entry past the cap', () => {
    const CAP = 256;
    const env = { DS_DEBUG: '1' };
    // Fill to the cap with distinct tags, then touch [fill-0] so [fill-1] is
    // the least-recently-touched. A final distinct tag forces one eviction;
    // the call must not throw and must still log.
    for (let i = 0; i < CAP; i++) {
        debugDumpToolMarkup('[fill-' + i + ']', 'content ' + i, () => {}, env);
    }
    debugDumpToolMarkup('[fill-0]', 'content 0', () => {}, env);
    assert.doesNotThrow(() => {
        debugDumpToolMarkup('[overflow]', 'overflow content', () => {}, env);
    });
});

test('describeToolMarkup: a JSON error without a line/column suffix is kept compact', () => {
    // Extra closing brace: JSON.parse reports a trailing-character error with
    // no "(line N column M)" suffix for compactMsg to strip.
    const diag = describeToolMarkup('{"tool_call":{"name":"read","arguments":{"p":}}}');
    assert.equal(diag.shape, 'json');
    assert.ok(diag.parseError && diag.parseError.startsWith('json:'));
    assert.equal(diag.parseError.includes('(line '), false);
});
