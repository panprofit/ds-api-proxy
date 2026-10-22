'use strict';

function toInt(value, fallback, { min = null, max = null } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    let out = Math.floor(n);
    if (min != null) out = Math.max(min, out);
    if (max != null) out = Math.min(max, out);
    return out;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function load(env = process.env) {
    const host = env.HOST || '127.0.0.1';
    const allowedOrigins = String(env.DS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
        port: toInt(env.PORT, 9876, { min: 1, max: 65535 }),
        host,
        remoteHost: 'chat.deepseek.com',

        maxConcurrent: toInt(env.DS_MAX_CONCURRENT, 10, { min: 1, max: 256 }),
        requestDeadlineMs: toInt(env.DS_REQUEST_DEADLINE_MS, 120000, { min: 1 }),

        maxUpstreamRetries: toInt(env.DS_MAX_UPSTREAM_RETRIES, 3, { min: 0, max: 10 }),

        maxSameAccountRetries: toInt(env.DS_MAX_SAME_ACCOUNT_RETRIES, 1, { min: 0, max: 10 }),

        rotationBudgetMs: toInt(env.DS_ROTATION_BUDGET_MS, 60000, { min: 1000 }),

        authDir: env.DS_AUTH_DIR || './.auth',
        accountCooldownMs: toInt(env.DS_ACCOUNT_COOLDOWN_MS, 5 * 60 * 1000, { min: 1 }),

        tokenRefreshIntervalMs: toInt(env.DS_TOKEN_REFRESH_INTERVAL_MS, 50 * 60 * 1000, { min: 0 }),

        accountMinCompletionIntervalMs: toInt(env.DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS, 6000, { min: 0 }),

        accountStateFlushMs: toInt(env.DS_ACCOUNT_STATE_FLUSH_MS, 60 * 1000, { min: 0 }),

        clientLocale: env.DS_CLIENT_LOCALE || 'en',
        clientTimezoneOffset: String(env.DS_CLIENT_TIMEZONE_OFFSET || '0'),

        sessionTtlMs: toInt(env.DS_SESSION_TTL_MS, 2 * 60 * 60 * 1000, { min: 1 }),
        maxSessions: toInt(env.DS_MAX_SESSIONS, 1000, { min: 1 }),
        sessionSweepIntervalMs: toInt(env.DS_SESSION_SWEEP_INTERVAL_MS, 10 * 60 * 1000, { min: 1000 }),

        uploadCacheTtlMs: toInt(env.DS_UPLOAD_CACHE_TTL_MS, 6 * 60 * 60 * 1000, { min: 1 }),
        maxUploadBytes: toInt(env.DS_MAX_UPLOAD_BYTES, 25 * 1024 * 1024, { min: 1 }),

        fetchTimeoutMs: toInt(env.DS_FETCH_TIMEOUT_MS, 60000, { min: 1 }),
        filePollIntervalMs: toInt(env.DS_FILE_POLL_INTERVAL_MS, 1000, { min: 1 }),
        filePollTimeoutMs: toInt(env.DS_FILE_POLL_TIMEOUT_MS, 60000, { min: 1 }),

        maxContinuation: toInt(env.DS_MAX_CONTINUATION, 2, { min: 0, max: 10 }),

        actionPromiseMaxChars: toInt(env.DS_ACTION_PROMISE_MAX_CHARS, 600, { min: 1 }),

        tokenRateLimitPerMin: toInt(env.DS_TOKEN_RATE_LIMIT_PER_MIN, 0, { min: 0 }),
        tokenRateBackoffFactor: toInt(env.DS_TOKEN_RATE_BACKOFF_FACTOR, 2, { min: 0, max: 10 }),
        continuationSizeThreshold: toInt(env.DS_CONTINUATION_SIZE_THRESHOLD, 25000, { min: 1 }),

        maxResponseWords: toInt(env.DS_MAX_RESPONSE_WORDS, 500, { min: 0 }),
        recoveryRetryDelayMs: toInt(env.DS_RECOVERY_RETRY_DELAY_MS, 500, { min: 0 }),

        defaultSearchEnabled: env.DS_DEFAULT_SEARCH_ENABLED !== '0',

        ignoreAgentSession: env.DS_IGNORE_AGENT_SESSION === '1',

        maxToolResultBytes: toInt(env.DS_MAX_TOOL_RESULT_BYTES, 64 * 1024, { min: 0 }),

        maxBodyBytes: toInt(env.DS_MAX_BODY_BYTES, 10 * 1024 * 1024, { min: 1 }),

        bodyReadTimeoutMs: toInt(env.DS_BODY_READ_TIMEOUT_MS, 30000, { min: 0 }),

        headersTimeoutMs: toInt(env.DS_HEADERS_TIMEOUT_MS, 60000, { min: 1000 }),
        requestTimeoutMs: toInt(env.DS_REQUEST_TIMEOUT_MS, 300000, { min: 1000 }),

        shutdownGraceMs: toInt(env.DS_SHUTDOWN_GRACE_MS, 15000, { min: 1000 }),

        allowedOrigins,
        hostIsLoopback: LOOPBACK_HOSTS.has(host),
        corsAllowAnyOrigin: allowedOrigins.length === 0 && LOOPBACK_HOSTS.has(host),

        streamKeepAliveMs: toInt(env.DS_STREAM_KEEPALIVE_MS, 15000, { min: 0 }),

        chromePath: env.CHROME_PATH || '',
        authCdpPort: toInt(env.DS_AUTH_CDP_PORT, 9339, { min: 1, max: 65535 }),
        loginFormTimeoutMs: toInt(env.DS_LOGIN_FORM_TIMEOUT_MS, 30000, { min: 1 }),
        loginTimeoutMs: toInt(env.DS_LOGIN_TIMEOUT_MS, 120000, { min: 1 }),
        keepProfile: env.DS_KEEP_PROFILE === '1',
    };
}

let current = load(process.env);

function get() { return current; }

function reload(overrides = {}) {
    current = load({ ...process.env, ...overrides });
    return current;
}

module.exports = { load, get, reload };
