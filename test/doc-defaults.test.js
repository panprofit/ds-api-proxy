'use strict';
// Parity between the docs/reference.md env table and the real defaults in
// lib/config.js. The table is hand-maintained, so a default lowered in
// config.js without touching the doc drifts silently (that is how
// DS_MAX_CONCURRENT and DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS went stale).
//
// This pins every documented default to `config.load({})`. The key -> field
// map is explicit because several fields are not a lowercase echo of the
// key (DS_MAX_RETRIES -> maxEmptyRetries, PORT -> port, ...), and the
// process-management keys are shell variables, not config.js fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../lib/config');

const REFERENCE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'reference.md'), 'utf8');

// Documented key -> field name in config.load({}).
const DOC_KEY_TO_CONFIG_FIELD = {
    PORT: 'port',
    HOST: 'host',
    DS_ACCOUNT_COOLDOWN_MS: 'accountCooldownMs',
    DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: 'accountMinCompletionIntervalMs',
    DS_ACCOUNT_STATE_FLUSH_MS: 'accountStateFlushMs',
    DS_CLIENT_LOCALE: 'clientLocale',
    DS_CLIENT_TIMEZONE_OFFSET: 'clientTimezoneOffset',
    DS_MAX_CONCURRENT: 'maxConcurrent',
    DS_REQUEST_DEADLINE_MS: 'requestDeadlineMs',
    DS_ROTATION_BUDGET_MS: 'rotationBudgetMs',
    DS_MAX_RETRIES: 'maxEmptyRetries',
    DS_MAX_UPSTREAM_RETRIES: 'maxUpstreamRetries',
    DS_MAX_CONTINUATION: 'maxContinuation',
    DS_MAX_REASONING_CONTINUATION: 'maxReasoningContinuation',
    DS_MAX_ACTION_PROMISE_CONTINUATION: 'maxActionPromiseContinuation',
    DS_ACTION_PROMISE_MAX_CHARS: 'actionPromiseMaxChars',
    DS_MAX_MARKUP_COMPLETION: 'maxMarkupCompletion',
    DS_MAX_UNKNOWN_TOOL_RETRIES: 'maxUnknownToolRetries',
    DS_MAX_TOOL_RESULT_ECHO_RETRIES: 'maxToolResultEchoRetries',
    DS_TOKEN_RATE_LIMIT_PER_MIN: 'tokenRateLimitPerMin',
    DS_TOKEN_RATE_BACKOFF_FACTOR: 'tokenRateBackoffFactor',
    DS_CONTINUATION_SIZE_THRESHOLD: 'continuationSizeThreshold',
    DS_MAX_RESPONSE_WORDS: 'maxResponseWords',
    DS_RECOVERY_RETRY_DELAY_MS: 'recoveryRetryDelayMs',
    DS_MALFORMED_TOOL_CALL_COOLDOWN_MS: 'malformedToolCallCooldownMs',
    DS_MAX_SESSION_RESETS_PER_ACCOUNT: 'maxSessionResetsPerAccount',
    DS_IGNORE_AGENT_SESSION: 'ignoreAgentSession',
    DS_SESSION_TTL_MS: 'sessionTtlMs',
    DS_MAX_SESSIONS: 'maxSessions',
    DS_SESSION_SWEEP_INTERVAL_MS: 'sessionSweepIntervalMs',
    DS_UPLOAD_CACHE_TTL_MS: 'uploadCacheTtlMs',
    DS_MAX_UPLOAD_BYTES: 'maxUploadBytes',
    DS_MAX_BODY_BYTES: 'maxBodyBytes',
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

// Env rows in docs/reference.md that belong to the start/stop shell scripts,
// not to lib/config.js, so there is no field to compare against.
const SCRIPT_ONLY_DOC_KEYS = new Set(['DS_PID_FILE', 'DS_LOG_FILE']);

// Parse the '| \`KEY\` | \`value\` |' rows into KEY -> number|boolean.
// Only backticked values are read, so '... (5 min)' suffixes are ignored.
function documentedDefaults() {
    const out = new Map();
    for (const m of REFERENCE.matchAll(/^\| `([A-Z0-9_]+)` *\| `([^`]+)`/gm)) {
        const [, key, raw] = m;
        // Keep the raw string when it is not a clean number (HOST, locale):
        // Number('127.0.0.1') / Number('en') are NaN, and a NaN would compare
        // unequal to the string default config.js actually holds.
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
        // Docs render booleans as 1/0 (DS_DEFAULT_SEARCH_ENABLED=1) and keep
        // numeric-looking strings quoted (DS_CLIENT_TIMEZONE_OFFSET='0'), so
        // compare stringified values and fold 1/0 to true/false for booleans.
        const docNorm = actual === true || actual === false ? (doc === 1 || doc === true) : String(doc);
        const actualNorm = actual === true || actual === false ? actual : String(actual);
        if (docNorm !== actualNorm) {
            mismatches.push(key + ': docs say ' + JSON.stringify(doc) + ', config.js has ' + JSON.stringify(actual) + ' (field ' + field + ')');
        }
    }
    assert.deepEqual(mismatches, [], 'docs/reference.md defaults out of sync with lib/config.js:\n' + mismatches.join('\n'));
});

test('doc defaults: the map covers every documented env key', () => {
    // Guards against a new env row added to docs/reference.md without a map
    // entry, which would silently skip the comparison above.
    const documented = documentedDefaults();
    const covered = new Set(Object.keys(DOC_KEY_TO_CONFIG_FIELD));
    const unchecked = [...documented.keys()]
        .filter((k) => !covered.has(k) && !SCRIPT_ONLY_DOC_KEYS.has(k))
        .sort();
    assert.deepEqual(unchecked, [], 'docs/reference.md env rows with no DOC_KEY_TO_CONFIG_FIELD entry: ' + unchecked.join(', '));
});
