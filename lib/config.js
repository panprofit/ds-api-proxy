'use strict';
// Central configuration. All environment parsing lives here so modules do not
// each reach into process.env, and so tests can reload a config from an
// injected env object without re-requiring the module graph.
//
// Values are read from `process.env` once at load time and exposed as a plain
// object. Call `load(env)` to (re)compute the object from a given env.
//
// Test policy: in-process tests change the config ONLY via
// `config.reload(overrides)` — never by assigning to process.env. reload()
// merges the overrides over process.env internally, so a throw can't leak a
// stale override into the next test. The sole exception is server-env.test.js,
// which spawns a child process and crosses the env boundary there.

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
        // Optional: defaults to the real upstream; tests override it via
        // config.reload(). The env read is the seam those tests rely on.
        remoteHost: env.DS_REMOTE_HOST || 'chat.deepseek.com',
        // Cap the concurrency so a typo (e.g. DS_MAX_CONCURRENT=100000) cannot
        // spawn hundreds of PoW computations and pin the CPU / get the accounts
        // rate-limited.
        maxConcurrent: toInt(env.DS_MAX_CONCURRENT, 24, { min: 1, max: 256 }),
        requestDeadlineMs: toInt(env.DS_REQUEST_DEADLINE_MS, 120000, { min: 1 }),
        maxEmptyRetries: toInt(env.DS_MAX_RETRIES, 2, { min: 0, max: 10 }),
        // Same-account retries when DS itself reports a transient outage
        // (finish_reason=generation_err / "Server temporarily unavailable.").
        // Rotating accounts cannot help because every account shares the same
        // upstream, so the recovery loop retries the current account instead.
        maxUpstreamRetries: toInt(env.DS_MAX_UPSTREAM_RETRIES, 3, { min: 0, max: 10 }),
        // Total wall-clock budget for cycling through accounts after failures.
        // The per-request deadline (DS_REQUEST_DEADLINE_MS) bounds the whole
        // request; this bounds just the rotation, so a request does not spend
        // its entire deadline waiting out cooldowns on every account.
        rotationBudgetMs: toInt(env.DS_ROTATION_BUDGET_MS, 60000, { min: 1000 }),
        malformedToolCallCooldownMs: toInt(env.DS_MALFORMED_TOOL_CALL_COOLDOWN_MS, 5 * 1000, { min: 1 }),

        // Accounts
        authDir: env.DS_AUTH_DIR,
        accountCooldownMs: toInt(env.DS_ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000, { min: 1 }),
        // Upstream requests allowed per account per rolling hour. Once an
        // account reaches the cap it is parked until the window resets, so the
        // next selectAccountForSession() rotates to another account. 0 disables
        // the cap (only the per-failure cooldown applies).
        accountMaxRequestsPerHour: toInt(env.DS_ACCOUNT_MAX_REQUESTS_PER_HOUR, 200, { min: 0 }),
        // Minimum spacing (ms) between two chat completions sent to the SAME
        // account. The upstream limit is per-frequency, not just per-hour: a
        // burst of back-to-back completions (e.g. several agents sharing one
        // sticky account) can trip it well before the hourly cap. Before each
        // completion the proxy waits until this much time has elapsed since the
        // account's previous completion. 0 disables the throttle.
        //
        // The wait happens BEFORE the PoW challenge is solved: the
        // X-DS-PoW-Response header is time/nonce-bound, so it must be created
        // right before the request goes out, not before a multi-second wait.
        accountMinCompletionIntervalMs: toInt(env.DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS, 5000, { min: 0 }),
        // Client identity sent upstream. Accounts in different regions may need
        // a matching locale/timezone, so these are global defaults that a
        // per-account auth config can still override (see accounts.buildBaseHeaders).
        clientLocale: env.DS_CLIENT_LOCALE || 'en',
        clientTimezoneOffset: String(env.DS_CLIENT_TIMEZONE_OFFSET || '0'),

        // Sessions
        // Idle TTL: a remote session is rolled over only after this much time
        // WITHOUT conversation activity (see sessions.prepareSessionForPrompt).
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
        // Rounds to turn a "promised action" (reasoning emitted, then a short
        // final line like "Let me check the tests" with finish_reason=stop and
        // no tool call) into an actual tool call or a real final answer. The
        // upstream sometimes ends the turn on the promise, stranding the
        // client until a manual "continue". 0 disables the phase.
        maxActionPromiseContinuation: toInt(env.DS_MAX_ACTION_PROMISE_CONTINUATION, 1, { min: 0, max: 10 }),
        // A final answer at or below this length, paired with non-empty
        // reasoning and finish_reason=stop, is treated as a possible
        // action-promise rather than a complete reply. Keep it small so real
        // short answers ("Done.", "Готово.") are only re-prompted when they
        // also carry a promise marker (see looksLikeActionPromise).
        actionPromiseMaxChars: toInt(env.DS_ACTION_PROMISE_MAX_CHARS, 600, { min: 1 }),
        maxMarkupCompletion: toInt(env.DS_MAX_MARKUP_COMPLETION, 2, { min: 0, max: 10 }),
        // One corrective retry when the model requests a tool that is not in
        // the request's `tools` list. Deterministic (same prompt -> same
        // hallucinated name), so it must NOT trigger session-reset/rotation;
        // a single re-prompt with the available names is enough.
        maxUnknownToolRetries: toInt(env.DS_MAX_UNKNOWN_TOOL_RETRIES, 1, { min: 0, max: 10 }),
        continuationSizeThreshold: toInt(env.DS_CONTINUATION_SIZE_THRESHOLD, 25000, { min: 1 }),
        recoveryRetryDelayMs: toInt(env.DS_RECOVERY_RETRY_DELAY_MS, 500, { min: 0 }),
        // How many consecutive new remote sessions may be created on the SAME
        // account to recover from malformed tool-call markup before the account
        // itself is abandoned and the next one is selected.
        maxSessionResetsPerAccount: toInt(env.DS_MAX_SESSION_RESETS_PER_ACCOUNT, 3, { min: 1 }),

        // Default value of the upstream `search_enabled` flag when the request
        // does not carry `web_search_options`. Kept on (true) to preserve the
        // historical behaviour; set DS_DEFAULT_SEARCH_ENABLED=0 for strict
        // OpenAI semantics (absent == off). An explicit web_search_options
        // always forces it on regardless of this default.
        defaultSearchEnabled: env.DS_DEFAULT_SEARCH_ENABLED !== '0',

        // Body size limit for incoming requests.
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

        // Auth helper (scripts/auth.js). The login helper is a one-shot CLI, so
        // these are read once at startup like the rest of the config. Keeping
        // them here means scripts/auth.js never reaches into process.env.
        chromePath: env.CHROME_PATH || '',
        authCdpPort: toInt(env.DS_AUTH_CDP_PORT, 9339, { min: 1, max: 65535 }),
        loginFormTimeoutMs: toInt(env.DS_LOGIN_FORM_TIMEOUT_MS, 30000, { min: 1 }),
        loginTimeoutMs: toInt(env.DS_LOGIN_TIMEOUT_MS, 120000, { min: 1 }),
        keepProfile: env.DS_KEEP_PROFILE === '1',
    };
}

// Mutable current config. Reassigned by `reload()`.
let current = load(process.env);

// Runtime access policy:
//   - Request-path code reads values through config.get() at CALL time, so a
//     test (or a future runtime reload) sees the current object.
//   - A few modules also export a load-time SNAPSHOT constant (e.g.
//     sessions.SESSION_TTL_MS, upstream.DS_FETCH_TIMEOUT_MS) kept only for
//     tests/back-compat. Those do NOT track reload(); do not read them from
//     request-path code.
function get() { return current; }
// Test-only: recompute `current` from process.env plus `overrides`. The server
// loads config once at boot and never reloads at runtime, so this exists only
// so tests can point modules at a tweaked environment without re-requiring the
// module graph. Do not call it from request-path code.
//
// `load(env)` stays the pure, full-env primitive (pass the whole env, e.g.
// `load({})` to assert defaults); `reload` is the ergonomic override form:
//   reload({ PORT: '9999' })   // everything else from process.env
function reload(overrides = {}) {
    current = load({ ...process.env, ...overrides });
    return current;
}

module.exports = { load, get, reload };
