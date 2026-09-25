'use strict';
// HTTP helpers: origin normalization, CORS headers and upstream error
// construction. Pure functions, no server state.

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

// True when `address` is a loopback peer address. Accepts the common IPv4 and
// IPv6 forms Node reports on `socket.remoteAddress`: `127.0.0.1` (and the rest
// of 127/8), `::1`, and IPv4-mapped IPv6 like `::ffff:127.0.0.1`.
function isLoopbackAddress(address) {
    const addr = String(address || '').toLowerCase();
    if (!addr) return false;
    if (addr === '::1') return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped before the IPv4 check.
    const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return v4.startsWith('127.');
}

// Request headers the proxy reads. Browsers preflight any header that is not
// CORS-safelisted, so every session-routing header accepted by resolveAgentId
// (plus Authorization) must be listed or the preflight fails.
const CORS_ALLOWED_HEADERS = [
    'Content-Type',
    'Authorization',
    'x-agent-session',
    'x-session-affinity',
    'x-session-id',
    'session_id',
    'x-client-request-id',
].join(', ');

function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
}

// Apply the full CORS response in one place: Vary, the (conditional)
// Access-Control-Allow-Origin, and the static methods/allow-headers. The
// single source of truth for CORS response headers. An origin is reflected
// only when it is allow-listed, or when `allowAnyOrigin` is set (the caller
// derives that from config: empty allowlist AND a loopback bind).
function applyCorsHeaders(res, { requestOrigin = '', allowedOrigins = [], allowAnyOrigin = false } = {}) {
    res.setHeader('Vary', 'Origin');
    const normalized = requestOrigin ? normalizeOrigin(requestOrigin) : '';
    if (normalized && (allowAnyOrigin || allowedOrigins.includes(normalized))) {
        res.setHeader('Access-Control-Allow-Origin', normalized);
    }
    setCorsResponseHeaders(res);
}

// Write the SSE response head and flush it, so keep-alive comment frames can
// flow before the (potentially long) upstream wait. Idempotent: a no-op once
// headers have been committed.
function writeSseHeaders(res) {
    if (res.headersSent) return;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

// Single mapping from an upstream HTTP status to the error `type` used across
// the proxy, so the upstream layer, the recovery loop and the client-facing
// response body all agree on the vocabulary.
function typeForStatus(status) {
    const code = Number(status) || 502;
    if (code === 429) return 'rate_limit_error';
    if (code === 401 || code === 403) return 'authentication_error';
    return 'upstream_http_error';
}

// Build an Error carrying the proxy's standard classification fields
// (`type` + `status`, plus any extras). Upstream failures that are not plain
// HTTP responses -- non-JSON bodies, protocol drift, missing credential
// material -- go through this so the recovery loop (`isAuthExpiredError`) and
// the HTTP error writer classify them identically instead of each caller
// inventing its own shape (or, worse, throwing a bare Error that surfaces as a
// generic 500).
function createTypedError(type, status, message, extra = {}) {
    const error = new Error(message);
    error.type = type;
    error.status = Number(status) || 502;
    Object.assign(error, extra);
    return error;
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    // Do not put the upstream body in the client-facing message: it may contain
    // HTML, tokens or internal details. Keep a truncated copy on the error object
    // for server-side logging only.
    const error = createTypedError(typeForStatus(code), code, `DS upstream HTTP ${code}`);
    error.upstreamBody = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300);
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

// Patterns that indicate a message may embed secrets from an upstream body:
// bearer tokens, cookies, long base64/JWT blobs and the DS response prefixes
// that PoW/JSON parse failures embed in their messages.
const SECRET_PATTERNS = [
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    /(?:set-cookie|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    /[A-Za-z0-9+/]{40,}={0,2}/g,
];

// Return a log-safe message. `createUpstreamHttpError` already keeps the body
// off `message`, but non-HTTP errors (PoW, JSON parsing) embed the first ~120
// chars of the DS response in their message. Strip anything that looks like a
// credential before it reaches logs/CI.
function redactError(e) {
    const raw = typeof e === 'string' ? e : String(e?.message || e || '');
    let out = raw;
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
    if (out.length > 500) out = out.slice(0, 500) + '…';
    return out;
}

module.exports = {
    normalizeOrigin,
    isLoopbackAddress,
    setCorsResponseHeaders,
    applyCorsHeaders,
    writeSseHeaders,
    typeForStatus,
    createTypedError,
    createUpstreamHttpError,
    isTimeoutError,
    redactError,
};
