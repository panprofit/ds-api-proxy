'use strict';
// Unit tests for the centralized config module.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');

test('config.load: defaults when env is empty', () => {
    const c = config.load({});
    assert.equal(c.port, 9876);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.remoteHost, config.get().remoteHost);
    assert.equal(c.maxConcurrent, 24);


test('load: DS_MAX_CONCURRENT is capped at 256', () => {
    assert.equal(config.load({ DS_MAX_CONCURRENT: '100000' }).maxConcurrent, 256);
    assert.equal(config.load({ DS_MAX_CONCURRENT: '256' }).maxConcurrent, 256);
    assert.equal(config.load({ DS_MAX_CONCURRENT: '0' }).maxConcurrent, 1);
});
    assert.equal(c.requestDeadlineMs, 120000);
    assert.equal(c.maxEmptyRetries, 2);
    assert.equal(c.maxUpstreamRetries, 3);
    assert.equal(c.malformedToolCallCooldownMs, 5000);
    assert.equal(c.accountCooldownMs, 10 * 60 * 1000);
    assert.equal(c.accountMinCompletionIntervalMs, 5000);
    assert.equal(c.accountStateFlushMs, 60 * 1000);
    assert.equal(c.sessionTtlMs, 2 * 60 * 60 * 1000);
    assert.equal(c.maxSessions, 1000);
    assert.equal(c.fetchTimeoutMs, 60000);
    assert.equal(c.maxUploadBytes, 25 * 1024 * 1024);
    assert.equal(c.maxSessionResetsPerAccount, 3);
    assert.equal(c.maxUnknownToolRetries, 1);
    assert.equal(c.maxToolResultEchoRetries, 1);
    assert.equal(c.shutdownGraceMs, 15000);
});

test('config.load: parses and overrides from env', () => {
    const c = config.load({
        PORT: '9999',
        HOST: '0.0.0.0',
        DS_REMOTE_HOST: 'example.com',
        DS_MAX_CONCURRENT: '5',
        DS_REQUEST_DEADLINE_MS: '1000',
        DS_MAX_RETRIES: '7',
        DS_MALFORMED_TOOL_CALL_COOLDOWN_MS: '250',
        DS_SESSION_TTL_MS: '1234',
        DS_AUTH_DIR: '/auth',
    });
    assert.equal(c.port, 9999);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.remoteHost, 'example.com');
    assert.equal(c.maxConcurrent, 5);
    assert.equal(c.requestDeadlineMs, 1000);
    assert.equal(c.maxEmptyRetries, 7);
    assert.equal(c.malformedToolCallCooldownMs, 250);
    assert.equal(c.sessionTtlMs, 1234);
    assert.equal(c.authDir, '/auth');
});

test('config.load: DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS default, override and clamp', () => {
    assert.equal(config.load({}).accountMinCompletionIntervalMs, 5000);
    assert.equal(config.load({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '250' }).accountMinCompletionIntervalMs, 250);
    assert.equal(config.load({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }).accountMinCompletionIntervalMs, 0);
    assert.equal(config.load({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '-5' }).accountMinCompletionIntervalMs, 0);
    assert.equal(config.load({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: 'nope' }).accountMinCompletionIntervalMs, 5000);
});

test('config.load: DS_ACCOUNT_STATE_FLUSH_MS default, override and clamp', () => {
    assert.equal(config.load({}).accountStateFlushMs, 60000);
    assert.equal(config.load({ DS_ACCOUNT_STATE_FLUSH_MS: '1500' }).accountStateFlushMs, 1500);
    assert.equal(config.load({ DS_ACCOUNT_STATE_FLUSH_MS: '0' }).accountStateFlushMs, 0);
    assert.equal(config.load({ DS_ACCOUNT_STATE_FLUSH_MS: '-5' }).accountStateFlushMs, 0);
    assert.equal(config.load({ DS_ACCOUNT_STATE_FLUSH_MS: 'nope' }).accountStateFlushMs, 60000);
});

test('config.load: token-rate adaptive throttle defaults, override and clamp', () => {
    // Off by default: the adaptive part must be opted into explicitly.
    assert.equal(config.load({}).tokenRateLimitPerMin, 0);
    assert.equal(config.load({ DS_TOKEN_RATE_LIMIT_PER_MIN: '6000' }).tokenRateLimitPerMin, 6000);
    assert.equal(config.load({ DS_TOKEN_RATE_LIMIT_PER_MIN: '-5' }).tokenRateLimitPerMin, 0);
    assert.equal(config.load({ DS_TOKEN_RATE_LIMIT_PER_MIN: 'nope' }).tokenRateLimitPerMin, 0);

    assert.equal(config.load({}).tokenRateBackoffFactor, 2);
    assert.equal(config.load({ DS_TOKEN_RATE_BACKOFF_FACTOR: '4' }).tokenRateBackoffFactor, 4);
    assert.equal(config.load({ DS_TOKEN_RATE_BACKOFF_FACTOR: '99' }).tokenRateBackoffFactor, 10);
    assert.equal(config.load({ DS_TOKEN_RATE_BACKOFF_FACTOR: '-5' }).tokenRateBackoffFactor, 0);
    assert.equal(config.load({ DS_TOKEN_RATE_BACKOFF_FACTOR: 'nope' }).tokenRateBackoffFactor, 2);
});

test('config.load: DS_MAX_RESPONSE_WORDS default, override and clamp', () => {
    assert.equal(config.load({}).maxResponseWords, 500);
    assert.equal(config.load({ DS_MAX_RESPONSE_WORDS: '150' }).maxResponseWords, 150);
    assert.equal(config.load({ DS_MAX_RESPONSE_WORDS: '0' }).maxResponseWords, 0);
    assert.equal(config.load({ DS_MAX_RESPONSE_WORDS: '-5' }).maxResponseWords, 0);
    assert.equal(config.load({ DS_MAX_RESPONSE_WORDS: 'nope' }).maxResponseWords, 500);
});

test('config.load: clamps maxUnknownToolRetries to [0,10]', () => {
    assert.equal(config.load({}).maxUnknownToolRetries, 1);
    assert.equal(config.load({ DS_MAX_UNKNOWN_TOOL_RETRIES: '5' }).maxUnknownToolRetries, 5);
    assert.equal(config.load({ DS_MAX_UNKNOWN_TOOL_RETRIES: '99' }).maxUnknownToolRetries, 10);
    assert.equal(config.load({ DS_MAX_UNKNOWN_TOOL_RETRIES: '-5' }).maxUnknownToolRetries, 0);
    assert.equal(config.load({ DS_MAX_UNKNOWN_TOOL_RETRIES: 'nope' }).maxUnknownToolRetries, 1);
    assert.equal(config.load({}).maxToolResultEchoRetries, 1);
    assert.equal(config.load({ DS_MAX_TOOL_RESULT_ECHO_RETRIES: '5' }).maxToolResultEchoRetries, 5);
    assert.equal(config.load({ DS_MAX_TOOL_RESULT_ECHO_RETRIES: '99' }).maxToolResultEchoRetries, 10);
    assert.equal(config.load({ DS_MAX_TOOL_RESULT_ECHO_RETRIES: '-5' }).maxToolResultEchoRetries, 0);
    assert.equal(config.load({ DS_MAX_TOOL_RESULT_ECHO_RETRIES: 'nope' }).maxToolResultEchoRetries, 1);
});

test('config.load: clamps maxEmptyRetries to [0,10]', () => {
    assert.equal(config.load({ DS_MAX_RETRIES: '99' }).maxEmptyRetries, 10);
    assert.equal(config.load({ DS_MAX_RETRIES: '-5' }).maxEmptyRetries, 0);
    assert.equal(config.load({ DS_MAX_RETRIES: 'not-a-number' }).maxEmptyRetries, 2);
});

test('config.load: ignores non-numeric values, keeps defaults', () => {
    const c = config.load({ PORT: 'abc', DS_MAX_CONCURRENT: 'x' });
    assert.equal(c.port, 9876);
    assert.equal(c.maxConcurrent, 24);
});

test('config.get / reload round-trip', () => {
    const before = config.get();
    const reloaded = config.reload({ PORT: '1234' });
    assert.equal(reloaded.port, 1234);
    assert.equal(config.get().port, 1234);
    // restore
    config.reload({});
    assert.ok(before);
});

test('config.load: body-read and socket-timeout defaults', () => {
    const c = config.load({});
    assert.equal(c.bodyReadTimeoutMs, 30000);
    assert.equal(c.headersTimeoutMs, 60000);
    assert.equal(c.requestTimeoutMs, 300000);
});

test('config.load: shutdownGraceMs honors override and clamps to >= 1000', () => {
    assert.equal(config.load({}).shutdownGraceMs, 15000);
    assert.equal(config.load({ DS_SHUTDOWN_GRACE_MS: '30000' }).shutdownGraceMs, 30000);
    assert.equal(config.load({ DS_SHUTDOWN_GRACE_MS: '5' }).shutdownGraceMs, 1000);
    assert.equal(config.load({ DS_SHUTDOWN_GRACE_MS: 'nope' }).shutdownGraceMs, 15000);
});

test('config.load: auth-helper defaults', () => {
    const c = config.load({});
    assert.equal(c.chromePath, '');
    assert.equal(c.authCdpPort, 9339);
    assert.equal(c.loginFormTimeoutMs, 30000);
    assert.equal(c.loginTimeoutMs, 120000);
    assert.equal(c.keepProfile, false);
});

test('config.load: auth-helper overrides from env', () => {
    const c = config.load({
        CHROME_PATH: '/usr/bin/chromium',
        DS_AUTH_CDP_PORT: '9444',
        DS_LOGIN_FORM_TIMEOUT_MS: '5000',
        DS_LOGIN_TIMEOUT_MS: '60000',
        DS_KEEP_PROFILE: '1',
    });
    assert.equal(c.chromePath, '/usr/bin/chromium');
    assert.equal(c.authCdpPort, 9444);
    assert.equal(c.loginFormTimeoutMs, 5000);
    assert.equal(c.loginTimeoutMs, 60000);
    assert.equal(c.keepProfile, true);
});

test('config.load: DS_KEEP_PROFILE requires exact "1"', () => {
    assert.equal(config.load({ DS_KEEP_PROFILE: '0' }).keepProfile, false);
});

test('config.load: authCdpPort is clamped to [1,65535]', () => {
    assert.equal(config.load({ DS_AUTH_CDP_PORT: '0' }).authCdpPort, 1);
    assert.equal(config.load({ DS_AUTH_CDP_PORT: '99999' }).authCdpPort, 65535);
    assert.equal(config.load({ DS_AUTH_CDP_PORT: 'abc' }).authCdpPort, 9339);
});

test('config.load: defaultSearchEnabled defaults on, DS_DEFAULT_SEARCH_ENABLED=0 turns it off', () => {
    assert.equal(config.load({}).defaultSearchEnabled, true);
    assert.equal(config.load({ DS_DEFAULT_SEARCH_ENABLED: '0' }).defaultSearchEnabled, false);
    assert.equal(config.load({ DS_DEFAULT_SEARCH_ENABLED: '1' }).defaultSearchEnabled, true);
});

test('config.load: requireAgentSession defaults off, DS_REQUIRE_AGENT_SESSION=1 turns it on', () => {
    assert.equal(config.load({}).requireAgentSession, false);
    assert.equal(config.load({ DS_REQUIRE_AGENT_SESSION: '1' }).requireAgentSession, true);
    assert.equal(config.load({ DS_REQUIRE_AGENT_SESSION: '0' }).requireAgentSession, false);
});
