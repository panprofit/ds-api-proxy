'use strict';
// Unit tests for lib/recovery-classify.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeContent,
    isContinuationRecoverySafe,
    isContextTooLongError,
    isRefusalContent,
    normalizeRetryResponse,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    isAuthExpiredError,
} = require('../lib/recovery-classify');

test('sanitizeContent: strips lone surrogates but keeps valid pairs', () => {
    assert.equal(sanitizeContent('a\ud800b'), 'ab');
    assert.equal(sanitizeContent('a\udc00b'), 'ab');
    assert.equal(sanitizeContent('ok \u{1F600}'), 'ok \u{1F600}');
});

test('sanitizeContent: nullish -> empty string', () => {
    assert.equal(sanitizeContent(null), '');
    assert.equal(sanitizeContent(undefined), '');
    assert.equal(sanitizeContent(0), '0');
});

test('isContinuationRecoverySafe: same account is safe', () => {
    assert.equal(isContinuationRecoverySafe('a1', { account: { id: 'a1' } }), true);
});

test('isContinuationRecoverySafe: different account is unsafe', () => {
    assert.equal(isContinuationRecoverySafe('a1', { account: { id: 'a2' } }), false);
});

test('isContinuationRecoverySafe: freshSessionReset overrides account change', () => {
    assert.equal(isContinuationRecoverySafe('a1', { account: { id: 'a2' }, freshSessionReset: true }), true);
});

test('isContinuationRecoverySafe: missing previous or next id is safe', () => {
    assert.equal(isContinuationRecoverySafe(null, { account: { id: 'a2' } }), true);
    assert.equal(isContinuationRecoverySafe('a1', {}), true);
    assert.equal(isContinuationRecoverySafe('a1', null), true);
});

test('isRefusalContent: matches refusal markers case-insensitively', () => {
    assert.equal(isRefusalContent('I am an AI assistant and cannot help with that.'), true);
    assert.equal(isRefusalContent("I'm an AI, so I can't continue."), true);
    assert.equal(isRefusalContent('AS AN AI language model, I must decline.'), true);
    assert.equal(isRefusalContent('I cannot continue this response.'), true);
});

test('isRefusalContent: false for real continuation text and empty input', () => {
    assert.equal(isRefusalContent('Here is the rest of the function:\n  return x;'), false);
    assert.equal(isRefusalContent(''), false);
    assert.equal(isRefusalContent(null), false);
    assert.equal(isRefusalContent(undefined), false);
});

test('isContextTooLongError: matches English context/token phrasings', () => {
    assert.equal(isContextTooLongError('context too long'), true);
    assert.equal(isContextTooLongError('prompt is too large'), true);
    assert.equal(isContextTooLongError('too many tokens'), true);
    assert.equal(isContextTooLongError('maximum context length exceeded'), true);
});

test('isContextTooLongError: matches localized phrasings', () => {
    assert.equal(isContextTooLongError('контекст слишком длинный'), true);
    assert.equal(isContextTooLongError('内容过长'), true);
    assert.equal(isContextTooLongError('上下文超出'), true);
});

test('isContextTooLongError: accepts strings and error objects', () => {
    assert.equal(isContextTooLongError({ content: 'context too long' }), true);
    assert.equal(isContextTooLongError({ message: 'too many tokens' }), true);
});

test('isContextTooLongError: false for unrelated errors', () => {
    assert.equal(isContextTooLongError('rate limited'), false);
    assert.equal(isContextTooLongError(null), false);
});

test('normalizeRetryResponse: sanitizes and defaults fields', () => {
    const out = normalizeRetryResponse({
        content: 'hi\ud800',
        reasoningContent: 'think\ud800',
        finishReason: 'stop',
        modelError: { type: 'error' },
    });
    assert.equal(out.content, 'hi');
    assert.equal(out.reasoningContent, 'think');
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.modelError, { type: 'error' });
});

test('normalizeRetryResponse: empty/missing -> defaults', () => {
    const out = normalizeRetryResponse(null);
    assert.equal(out.content, '');
    assert.equal(out.reasoningContent, '');
    assert.equal(out.finishReason, null);
    assert.equal(out.modelError, null);
});

test('classifyRecoveryFailure: context-too-long -> 400', () => {
    assert.deepEqual(classifyRecoveryFailure('context too long'), { status: 400, type: 'context_length_exceeded' });
});

test('classifyRecoveryFailure: timeout -> 504', () => {
    assert.deepEqual(classifyRecoveryFailure(null, true), { status: 504, type: 'request_timeout' });
});

test('classifyRecoveryFailure: model error type is propagated', () => {
    assert.deepEqual(classifyRecoveryFailure({ type: 'rate_limit' }), { status: 502, type: 'rate_limit' });
});

test('classifyRecoveryFailure: defaults to empty_response 502', () => {
    assert.deepEqual(classifyRecoveryFailure(null), { status: 502, type: 'empty_response' });
});

test('isUpstreamTransientError: generation_err and the DS outage message', () => {
    assert.equal(isUpstreamTransientError({ type: 'error', finish_reason: 'generation_err' }), true);
    assert.equal(isUpstreamTransientError({ content: 'Сервер временно недоступен.' }), true);
    assert.equal(isUpstreamTransientError({ content: 'Server temporarily unavailable' }), true);
    assert.equal(isUpstreamTransientError({ content: '服务器暂时不可用' }), true);
});

test('isUpstreamTransientError: false for unrelated/empty input', () => {
    assert.equal(isUpstreamTransientError(null), false);
    assert.equal(isUpstreamTransientError('some string'), false);
    assert.equal(isUpstreamTransientError({ type: 'error', finish_reason: 'length' }), false);
    assert.equal(isUpstreamTransientError({}), false);
});

test('classifyRecoveryFailure: DS outage -> 503 upstream_unavailable', () => {
    assert.deepEqual(
        classifyRecoveryFailure({ type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' }),
        { status: 503, type: 'upstream_unavailable' },
    );
});

test('classifyRecoveryFailure: context check wins over timeout', () => {
    assert.equal(classifyRecoveryFailure('context too long', true).status, 400);
});

// --- isAuthExpiredError -----------------------------------------------------
// Regression guard: "Auth may be expired, captcha may be required, or DS
// changed Web API" must be classified as a per-account failure so the recovery
// loop rotates to another account instead of retrying a dead one.

test('isAuthExpiredError: true on the auth_expired type', () => {
    assert.equal(isAuthExpiredError({ type: 'auth_expired' }), true);
    assert.equal(isAuthExpiredError({ type: 'authentication_error' }), true);
});

test('isAuthExpiredError: matches the DS error strings', () => {
    assert.equal(isAuthExpiredError('Auth may be expired, captcha may be required, or DS changed Web API.'), true);
    assert.equal(isAuthExpiredError({ message: 'HTTP 401. Auth may be expired/captcha-blocked.' }), true);
    assert.equal(isAuthExpiredError({ content: 'captcha-blocked' }), true);
    assert.equal(isAuthExpiredError({ message: 'DS changed Web API' }), true);
});

test('isAuthExpiredError: false for unrelated errors', () => {
    assert.equal(isAuthExpiredError('rate limited'), false);
    assert.equal(isAuthExpiredError(null), false);
    assert.equal(isAuthExpiredError(undefined), false);
    assert.equal(isAuthExpiredError({ type: 'rate_limit' }), false);
});
