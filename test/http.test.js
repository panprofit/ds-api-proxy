'use strict';
// Unit tests for lib/http.js (origin normalization, CORS headers, upstream
// error construction, timeout classification).

const test = require('node:test');
const assert = require('node:assert/strict');

const http = require('../lib/http');

// --- normalizeOrigin --------------------------------------------------------

test('normalizeOrigin: empty/falsy input returns empty string', () => {
    assert.equal(http.normalizeOrigin(''), '');
    assert.equal(http.normalizeOrigin(null), '');
    assert.equal(http.normalizeOrigin(undefined), '');
    assert.equal(http.normalizeOrigin('   '), '');
});

test('normalizeOrigin: strips trailing slashes and normalizes to origin', () => {
    assert.equal(http.normalizeOrigin('https://example.com/'), 'https://example.com');
    assert.equal(http.normalizeOrigin('https://example.com/path/'), 'https://example.com');
    assert.equal(http.normalizeOrigin('http://a.b.c:8080//'), 'http://a.b.c:8080');
});

test('normalizeOrigin: preserves the literal "null" origin', () => {
    assert.equal(http.normalizeOrigin('null'), 'null');
});

test('normalizeOrigin: keeps unparseable values as-is (minus trailing slashes)', () => {
    assert.equal(http.normalizeOrigin('not a url/'), 'not a url');
});

// --- isLoopbackAddress ------------------------------------------------------

test('isLoopbackAddress: accepts IPv4/IPv6 loopback and IPv4-mapped forms', () => {
    assert.equal(http.isLoopbackAddress('127.0.0.1'), true);
    assert.equal(http.isLoopbackAddress('127.5.6.7'), true);
    assert.equal(http.isLoopbackAddress('::1'), true);
    assert.equal(http.isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('isLoopbackAddress: rejects public/private non-loopback addresses', () => {
    assert.equal(http.isLoopbackAddress('203.0.113.5'), false);
    assert.equal(http.isLoopbackAddress('10.0.0.1'), false);
    assert.equal(http.isLoopbackAddress('::ffff:8.8.8.8'), false);
    assert.equal(http.isLoopbackAddress(''), false);
    assert.equal(http.isLoopbackAddress(undefined), false);
});

// --- setCorsResponseHeaders -------------------------------------------------

function fakeRes() {
    return {
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
    };
}

test('setCorsResponseHeaders: sets methods and allows the session-routing headers', () => {
    const res = fakeRes();
    http.setCorsResponseHeaders(res);
    assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST, GET, OPTIONS');
    const allowed = res.headers['Access-Control-Allow-Headers'];
    // The browser preflights these, so they must be present or the request is blocked.
    for (const h of ['Content-Type', 'Authorization', 'x-agent-session', 'x-session-affinity', 'x-session-id', 'session_id', 'x-client-request-id']) {
        assert.ok(allowed.includes(h), );
    }
});

// --- typeForStatus / createTypedError ---------------------------------------

test('typeForStatus: is the single source of the status -> type mapping', () => {
    assert.equal(http.typeForStatus(429), 'rate_limit_error');
    assert.equal(http.typeForStatus(401), 'authentication_error');
    assert.equal(http.typeForStatus(403), 'authentication_error');
    assert.equal(http.typeForStatus(500), 'upstream_http_error');
    assert.equal(http.typeForStatus(400), 'upstream_http_error');
    // Falsy/garbage statuses fall back to 502 upstream_http_error.
    assert.equal(http.typeForStatus(null), 'upstream_http_error');
    assert.equal(http.typeForStatus('abc'), 'upstream_http_error');
    assert.equal(http.typeForStatus(0), 'upstream_http_error');
});

test('createTypedError: attaches type/status and any extras', () => {
    const err = http.createTypedError('auth_expired', 401, 'nope', { account: 'a1' });
    assert.equal(err.message, 'nope');
    assert.equal(err.type, 'auth_expired');
    assert.equal(err.status, 401);
    assert.equal(err.account, 'a1');
});

test('createTypedError: defaults a falsy/garbage status to 502', () => {
    assert.equal(http.createTypedError('x', null, 'm').status, 502);
    assert.equal(http.createTypedError('x', 'abc', 'm').status, 502);
    assert.equal(http.createTypedError('x', 0, 'm').status, 502);
});

// --- createUpstreamHttpError ------------------------------------------------

test('createUpstreamHttpError: maps status codes to error types', () => {
    assert.equal(http.createUpstreamHttpError(429).type, 'rate_limit_error');
    assert.equal(http.createUpstreamHttpError(401).type, 'authentication_error');
    assert.equal(http.createUpstreamHttpError(403).type, 'authentication_error');
    assert.equal(http.createUpstreamHttpError(500).type, 'upstream_http_error');
    assert.equal(http.createUpstreamHttpError(400).type, 'upstream_http_error');
});

test('createUpstreamHttpError: defaults to 502 for falsy/garbage status', () => {
    assert.equal(http.createUpstreamHttpError(null).status, 502);
    assert.equal(http.createUpstreamHttpError('abc').status, 502);
    assert.equal(http.createUpstreamHttpError(0).status, 502);
});

test('createUpstreamHttpError: message never contains the upstream body', () => {
    const err = http.createUpstreamHttpError(500, '<html>SECRET TOKEN</html>');
    assert.equal(err.message, 'DS upstream HTTP 500');
    assert.ok(!err.message.includes('SECRET'));
});

test('createUpstreamHttpError: keeps a whitespace-collapsed, truncated body', () => {
    const err = http.createUpstreamHttpError(500, 'a\n\n  b   c');
    assert.equal(err.upstreamBody, 'a b c');
    const long = http.createUpstreamHttpError(500, 'x'.repeat(500));
    assert.equal(long.upstreamBody.length, 300);
});

test('createUpstreamHttpError: attaches retryAfter only when provided', () => {
    assert.equal(http.createUpstreamHttpError(429, '', '5').retryAfter, '5');
    assert.ok(!('retryAfter' in http.createUpstreamHttpError(429, '')));
});

// --- isTimeoutError ---------------------------------------------------------

test('isTimeoutError: detects AbortError/TimeoutError by name', () => {
    assert.equal(http.isTimeoutError({ name: 'AbortError' }), true);
    assert.equal(http.isTimeoutError({ name: 'TimeoutError' }), true);
});

test('isTimeoutError: detects timeout in the message', () => {
    assert.equal(http.isTimeoutError(new Error('request timed out')), true);
    assert.equal(http.isTimeoutError(new Error('Timeout while fetching')), true);
});

test('isTimeoutError: false for unrelated errors and nullish input', () => {
    assert.equal(http.isTimeoutError(new Error('boom')), false);
    assert.equal(http.isTimeoutError(null), false);
    assert.equal(http.isTimeoutError(undefined), false);
});

// --- redactError ------------------------------------------------------------

test('redactError: strips Bearer tokens and cookie values', () => {
    const out = http.redactError(new Error('auth Bearer abc123def456 failed; Cookie: session=deadbeef'));
    assert.ok(!out.includes('abc123def456'));
    assert.ok(!out.includes('deadbeef'));
    assert.ok(out.includes('[redacted]'));
});

test('redactError: strips long base64/JWT-looking blobs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = http.redactError(new Error(`bad token ${jwt} upstream`));
    assert.ok(!out.includes(jwt));
});

test('redactError: strips the DS PoW header value', () => {
    const out = http.redactError(new Error('sent X-DS-PoW-Response: s3cr3tPowValue to upstream'));
    assert.ok(!out.includes('s3cr3tPowValue'));
    assert.ok(out.includes('[redacted]'));
});

test('redactError: strips DS session cookies (ds_session_id / smidV2)', () => {
    const out = http.redactError(new Error('cookie ds_session_id=abc123; smidV2=def456; other=keep'));
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('def456'));
});

test('redactError: truncates very long messages', () => {
    // Use hyphenated text so the long-base64 pattern does not consume it first.
    const out = http.redactError(new Error('a-'.repeat(1000)));
    assert.ok(out.length <= 501);
    assert.ok(out.endsWith('\u2026'));
});

test('redactError: accepts a plain string and handles nullish', () => {
    assert.equal(http.redactError('all good'), 'all good');
    assert.equal(http.redactError(null), '');
    assert.equal(http.redactError(undefined), '');
});

// --- truncateForLog ---------------------------------------------------------

test('truncateForLog: returns the string unchanged when within max', () => {
    assert.equal(http.truncateForLog('hello', 10), 'hello');
    assert.equal(http.truncateForLog('hello', 5), 'hello');
});

test('truncateForLog: appends the ellipsis when it cuts', () => {
    assert.equal(http.truncateForLog('hello world', 5), 'hello\u2026');
});

test('truncateForLog: custom ellipsis, including empty', () => {
    assert.equal(http.truncateForLog('hello world', 5, ''), 'hello');
    assert.equal(http.truncateForLog('hello world', 5, '...'), 'hello...');
});

test('truncateForLog: never splits a surrogate pair (astral char)', () => {
    // \u{1F600} is a surrogate pair; a naive slice(0, 1) would leave a lone high surrogate.
    const text = 'a\u{1F600}b';
    // max=2 would land between the high and low surrogate of the emoji.
    const out = http.truncateForLog(text, 2, '');
    assert.equal(out, 'a');
    // The result must be well-formed (no lone surrogate): a re-encode round-trip
    // and code-point count both hold only when the pair was not split.
    assert.equal([...out].length, 1);
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out);
});

test('truncateForLog: a boundary exactly after a BMP char is kept', () => {
    assert.equal(http.truncateForLog('abcd', 2, ''), 'ab');
});

test('truncateForLog: handles null/undefined and non-strings', () => {
    assert.equal(http.truncateForLog(null, 10), '');
    assert.equal(http.truncateForLog(undefined, 10), '');
    assert.equal(http.truncateForLog(12345, 3, ''), '123');
});
