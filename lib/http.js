'use strict';

const BODY_NOT_JSON = 'Request body is not valid JSON.';
const BODY_NOT_OBJECT = 'Request body must be a JSON object.';
const TOOLS_NOT_ARRAY = 'Field tools must be an array.';

/** Return the standard invalid-request result used by the body parsers. */
function invalidRequest(message) {
    return { ok: false, error: { message, type: 'invalid_request_error', status: 400 } };
}

/**
 * @typedef {Error & {
 *   type?: string,
 *   status?: number,
 *   retryAfter?: string|number|null,
 *   upstreamBody?: string,
 * }} TypedError
 */

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

function isLoopbackAddress(address) {
    const addr = String(address || '').toLowerCase();
    if (!addr) return false;
    if (addr === '::1') return true;
    
    const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return v4.startsWith('127.');
}

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

function applyCorsHeaders(res, { requestOrigin = '', allowedOrigins = [], allowAnyOrigin = false } = {}) {
    res.setHeader('Vary', 'Origin');
    const normalized = requestOrigin ? normalizeOrigin(requestOrigin) : '';
    if (normalized && (allowAnyOrigin || allowedOrigins.includes(normalized))) {
        res.setHeader('Access-Control-Allow-Origin', normalized);
    }
    setCorsResponseHeaders(res);
}

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

function typeForStatus(status) {
    const code = Number(status) || 502;
    if (code === 429) return 'rate_limit_error';
    if (code === 401 || code === 403) return 'authentication_error';
    return 'upstream_http_error';
}

/**
 * @returns {TypedError}
 */
function createTypedError(type, status, message, extra = {}) {
    const error = /** @type {TypedError} */ (new Error(message));
    error.type = type;
    error.status = Number(status) || 502;
    Object.assign(error, extra);
    return error;
}

/**
 * @returns {TypedError}
 */
function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    
    const error = createTypedError(typeForStatus(code), code, `DS upstream HTTP ${code}`);
    error.upstreamBody = truncateForLog(String(body || '').replace(/\s+/g, ' ').trim(), 300, '');
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

const SECRET_PATTERNS = [
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    
    /(?:x-ds-pow-response|set-cookie|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi,
    
    /(?:ds_session_id|smidV2)\s*=\s*[^\s,;]+/gi,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    /[A-Za-z0-9+/]{40,}={0,2}/g,
];

function truncateForLog(text, max, ellipsis = '…') {
    const value = String(text == null ? '' : text);
    if (value.length <= max) return value;
    let end = max;
    
    const code = value.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF && end < value.length) end -= 1;
    return value.slice(0, end) + ellipsis;
}

function redactError(e) {
    const raw = typeof e === 'string' ? e : String(e?.message || e || '');
    let out = raw;
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
    return truncateForLog(out, 500);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function shortAgentId(agentId) {
    const value = String(agentId == null ? '' : agentId);
    return UUID_RE.test(value) ? value.split('-').pop() : value;
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
    truncateForLog,
    shortAgentId,
    BODY_NOT_JSON,
    BODY_NOT_OBJECT,
    TOOLS_NOT_ARRAY,
    invalidRequest,
};
