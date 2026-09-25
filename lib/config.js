'use strict';
// Central configuration. All environment parsing lives here so modules do not
// each reach into process.env, and so tests can reload a config from an
// injected env object without re-requiring the module graph.
//
// Values are read from `process.env` once at load time and exposed as a plain
// object. Call `load(env)` to (re)compute the object from a given env.

function toInt(value, fallback, { min = null, max = null } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    let out = Math.floor(n);
    if (min != null) out = Math.max(min, out);
    if (max != null) out = Math.min(max, out);
    return out;
}

// Hosts reachable only from the local machine. Decides whether an arbitrary
// CORS Origin may be reflected: on a non-loopback bind it must not be, else
// any web page could drive the proxy (CSRF).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function load(env = process.env) {
    const host = env.HOST || '127.0.0.1';
    const allowedOrigins = String(env.DS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
        // Server
        port: toInt(env.PORT, 9876, { min: 1, max: 65535 }),
        host,
        remoteHost: env.DS_REMOTE_HOST || '',
        maxConcurrent: toInt(env.DS_MAX_CONCURRENT, 24, { min: 1 }),
        requestDeadlineMs: toInt(env.DS_REQUEST_DEADLINE_MS, 120000, { min: 1 }),
        maxEmptyRetries: toInt(env.DS_MAX_RETRIES, 2, { min: 0, max: 10 }),
        // Same-account retries when DS itself reports a transient outage
        // (finish_reason=generation_err / "Server temporarily unavailable.").
        // Rotating accounts cannot help because every account shares the same
        // upstream, so the recovery loop retries the current account instead.
        maxUpstreamRetries: toInt(env.DS_MAX_UPSTREAM_RETRIES, 3, { min: 0, max: 10 }),
        malformedToolCallCooldownMs: toInt(env.DS_MALFORMED_TOOL_CALL_COOLDOWN_MS, 5 * 1000, { min: 1 }),

        // Accounts
        authDir: env.DS_AUTH_DIR,
        accountCooldownMs: toInt(env.DS_ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000, { min: 1 }),
        // Client identity sent upstream. Accounts in different regions may need
        // a matching locale/timezone, so these are global defaults that a
        // per-account auth config can still override (see accounts.buildBaseHeaders).
        clientLocale: env.DS_CLIENT_LOCALE || 'en',
        clientTimezoneOffset: String(env.DS_CLIENT_TIMEZONE_OFFSET || '0'),

        // Sessions
        sessionTtlMs: toInt(env.DS_SESSION_TTL_MS, 2 * 60 * 60 * 1000, { min: 1 }),
        maxSessions: toInt(env.DS_MAX_SESSIONS, 1000, { min: 1 }),
        sessionSweepIntervalMs: toInt(env.DS_SESSION_SWEEP_INTERVAL_MS, 10 * 60 * 1000, { min: 1000 }),

        // Uploads
        uploadCacheTtlMs: toInt(env.DS_UPLOAD_CACHE_TTL_MS, 6 * 60 * 60 * 1000, { min: 1 }),
        maxUploadBytes: toInt(env.DS_MAX_UPLOAD_BYTES, 25 * 1024 * 1024, { min: 1 }),

        // Upstream
        fetchTimeoutMs: toInt(env.DS_FETCH_TIMEOUT_MS, 60000, { min: 1 }),
        filePollIntervalMs: toInt(env.DS_FILE_POLL_INTERVAL_MS, 1000, { min: 1 }),
        filePollTimeoutMs: toInt(env.DS_FILE_POLL_TIMEOUT_MS, 60000, { min: 1 }),

        // Recovery
        maxContinuation: toInt(env.DS_MAX_CONTINUATION, 2, { min: 0, max: 10 }),
        // Rounds to turn a reasoning-only response into a visible final answer
        // so the client is not left with an empty message needing a manual continue.
        maxReasoningContinuation: toInt(env.DS_MAX_REASONING_CONTINUATION, 2, { min: 0, max: 10 }),
        maxMarkupCompletion: toInt(env.DS_MAX_MARKUP_COMPLETION, 2, { min: 0, max: 10 }),
        continuationSizeThreshold: toInt(env.DS_CONTINUATION_SIZE_THRESHOLD, 25000, { min: 1 }),
        recoveryRetryDelayMs: toInt(env.DS_RECOVERY_RETRY_DELAY_MS, 500, { min: 0 }),
        // How many consecutive new remote sessions may be created on the SAME
        // account to recover from malformed tool-call markup before the account
        // itself is abandoned and the next one is selected.
        maxSessionResetsPerAccount: toInt(env.DS_MAX_SESSION_RESETS_PER_ACCOUNT, 3, { min: 1 }),

        // Body size limit for incoming requests
        maxBodyBytes: toInt(env.DS_MAX_BODY_BYTES, 10 * 1024 * 1024, { min: 1 }),
        // Max time to receive a full request body before returning 408.
        bodyReadTimeoutMs: toInt(env.DS_BODY_READ_TIMEOUT_MS, 30000, { min: 0 }),
        // Socket-level timeouts (ms).
        headersTimeoutMs: toInt(env.DS_HEADERS_TIMEOUT_MS, 60000, { min: 1000 }),
        requestTimeoutMs: toInt(env.DS_REQUEST_TIMEOUT_MS, 300000, { min: 1000 }),
        // Grace period (ms) for draining in-flight requests and pending remote
        // session deletions on SIGTERM/SIGINT.
        shutdownGraceMs: toInt(env.DS_SHUTDOWN_GRACE_MS, 15000, { min: 1000 }),

        // CORS: a comma-separated allowlist restricts which browser origins
        // may call. When the allowlist is empty, an arbitrary Origin is
        // reflected ONLY on a loopback bind; on a non-loopback HOST no origin
        // is allowed (deny-by-default, anti-CSRF).
        allowedOrigins,
        hostIsLoopback: LOOPBACK_HOSTS.has(host),
        corsAllowAnyOrigin: allowedOrigins.length === 0 && LOOPBACK_HOSTS.has(host),

        // Interval for SSE keep-alive comment frames while an upstream request
        // is in flight. 0 disables heartbeats.
        streamKeepAliveMs: toInt(env.DS_STREAM_KEEPALIVE_MS, 15000, { min: 0 }),
    };
}

// Mutable current config. Reassigned by `reload()`.
let current = load(process.env);

function get() { return current; }
// Test-only: re-reads `env` (defaults to process.env) into `current`. The
// running server loads config once at boot and does NOT reload it at runtime,
// so this exists solely so tests can point individual modules at a tweaked
// environment without re-requiring the module graph. Do not call it from
// request-path code.
function reload(env = process.env) { current = load(env); return current; }

module.exports = { load, get, reload };
