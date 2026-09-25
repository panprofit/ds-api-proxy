'use strict';
// Unit tests for lib/pow.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPowHeader } = require('../lib/pow');

function decode(header) {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

test('buildPowHeader: encodes the challenge fields as base64 JSON', () => {
    const challenge = {
        algorithm: 'sha256',
        challenge: 'abc',
        salt: 'salt',
        signature: 'sig',
    };
    const out = buildPowHeader(challenge, 42);
    assert.equal(typeof out, 'string');
    assert.deepEqual(decode(out), {
        algorithm: 'sha256',
        challenge: 'abc',
        salt: 'salt',
        answer: 42,
        signature: 'sig',
        target_path: '/api/v0/chat/completion',
    });
});

test('buildPowHeader: honours a custom target path', () => {
    const out = buildPowHeader({ algorithm: 'a', challenge: 'c', salt: 's', signature: 'x' }, 1, '/api/v0/file/upload_file');
    assert.equal(decode(out).target_path, '/api/v0/file/upload_file');
});

test('buildPowHeader: output is valid base64', () => {
    const out = buildPowHeader({ algorithm: 'a', challenge: 'c', salt: 's', signature: 'x' }, 7);
    assert.ok(/^[A-Za-z0-9+/]+=*$/.test(out));
});

test('buildPowHeader: preserves the answer value unchanged', () => {
    assert.equal(decode(buildPowHeader({ algorithm: 'a', challenge: 'c', salt: 's', signature: 'x' }, 0)).answer, 0);
    assert.equal(decode(buildPowHeader({ algorithm: 'a', challenge: 'c', salt: 's', signature: 'x' }, 123456)).answer, 123456);
});
