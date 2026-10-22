'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../lib/config');

const REFERENCE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'reference.md'), 'utf8');

const DOC_KEY_TO_CONFIG_FIELD = {
    PORT: 'port',
    HOST: 'host',
    DS_AUTH_DIR: 'authDir',
    DS_ACCOUNT_COOLDOWN_MS: 'accountCooldownMs',
    DS_TOKEN_REFRESH_INTERVAL_MS: 'tokenRefreshIntervalMs',
    DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: 'accountMinCompletionIntervalMs',
    DS_ACCOUNT_STATE_FLUSH_MS: 'accountStateFlushMs',
    DS_CLIENT_LOCALE: 'clientLocale',
    DS_CLIENT_TIMEZONE_OFFSET: 'clientTimezoneOffset',
    DS_MAX_CONCURRENT: 'maxConcurrent',
    DS_REQUEST_DEADLINE_MS: 'requestDeadlineMs',
    DS_ROTATION_BUDGET_MS: 'rotationBudgetMs',
    DS_MAX_UPSTREAM_RETRIES: 'maxUpstreamRetries',
    DS_MAX_SAME_ACCOUNT_RETRIES: 'maxSameAccountRetries',
    DS_MAX_CONTINUATION: 'maxContinuation',
    DS_SESSION_JOURNAL: 'sessionJournalPath',
    DS_STICKY_THINKING_FALLBACK: 'stickyThinkingFallback',
    DS_TOKEN_RATE_LIMIT_PER_MIN: 'tokenRateLimitPerMin',
    DS_TOKEN_RATE_BACKOFF_FACTOR: 'tokenRateBackoffFactor',
    DS_CONTINUATION_SIZE_THRESHOLD: 'continuationSizeThreshold',
    DS_MAX_RESPONSE_WORDS: 'maxResponseWords',
    DS_RECOVERY_RETRY_DELAY_MS: 'recoveryRetryDelayMs',
    DS_IGNORE_AGENT_SESSION: 'ignoreAgentSession',
    DS_SESSION_TTL_MS: 'sessionTtlMs',
    DS_MAX_SESSIONS: 'maxSessions',
    DS_SESSION_SWEEP_INTERVAL_MS: 'sessionSweepIntervalMs',
    DS_UPLOAD_CACHE_TTL_MS: 'uploadCacheTtlMs',
    DS_MAX_UPLOAD_BYTES: 'maxUploadBytes',
    DS_MAX_BODY_BYTES: 'maxBodyBytes',
    DS_MAX_TOOL_RESULT_BYTES: 'maxToolResultBytes',
    DS_BODY_READ_TIMEOUT_MS: 'bodyReadTimeoutMs',
    DS_HEADERS_TIMEOUT_MS: 'headersTimeoutMs',
    DS_REQUEST_TIMEOUT_MS: 'requestTimeoutMs',
    DS_FETCH_TIMEOUT_MS: 'fetchTimeoutMs',
    DS_FILE_POLL_INTERVAL_MS: 'filePollIntervalMs',
    DS_FILE_POLL_TIMEOUT_MS: 'filePollTimeoutMs',
    DS_STREAM_KEEPALIVE_MS: 'streamKeepAliveMs',
    DS_DEFAULT_SEARCH_ENABLED: 'defaultSearchEnabled',
    DS_SHUTDOWN_GRACE_MS: 'shutdownGraceMs',
    DS_AUTH_CDP_PORT: 'authCdpPort',
    DS_LOGIN_FORM_TIMEOUT_MS: 'loginFormTimeoutMs',
    DS_LOGIN_TIMEOUT_MS: 'loginTimeoutMs',
    DS_KEEP_PROFILE: 'keepProfile',
};

const SCRIPT_ONLY_DOC_KEYS = new Set(['DS_PID_FILE', 'DS_LOG_FILE']);

function documentedDefaults() {
    const out = new Map();
    for (const m of REFERENCE.matchAll(/^\| `([A-Z0-9_]+)` *\| `([^`]+)`/gm)) {
        const [, key, raw] = m;

        const num = Number(raw);
        out.set(key, raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(num) ? raw : num);
    }
    return out;
}

test('doc defaults: every documented default matches config.load({})', () => {
    const defaults = config.load({});
    const documented = documentedDefaults();
    const mismatches = [];
    for (const [key, field] of Object.entries(DOC_KEY_TO_CONFIG_FIELD)) {
        if (!documented.has(key)) {
            mismatches.push(key + ': missing from docs/reference.md');
            continue;
        }
        const doc = documented.get(key);
        const actual = defaults[field];

        const docNorm = actual === true || actual === false ? (doc === 1 || doc === true) : String(doc);
        const actualNorm = actual === true || actual === false ? actual : String(actual);
        if (docNorm !== actualNorm) {
            mismatches.push(key + ': docs say ' + JSON.stringify(doc) + ', config.js has ' + JSON.stringify(actual) + ' (field ' + field + ')');
        }
    }
    assert.deepEqual(mismatches, [], 'docs/reference.md defaults out of sync with lib/config.js:\n' + mismatches.join('\n'));
});

test('doc defaults: the map covers every documented env key', () => {

    const documented = documentedDefaults();
    const covered = new Set(Object.keys(DOC_KEY_TO_CONFIG_FIELD));
    const unchecked = [...documented.keys()]
        .filter((k) => !covered.has(k) && !SCRIPT_ONLY_DOC_KEYS.has(k))
        .sort();
    assert.deepEqual(unchecked, [], 'docs/reference.md env rows with no DOC_KEY_TO_CONFIG_FIELD entry: ' + unchecked.join(', '));
});
