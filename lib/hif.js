'use strict';
// Fresh x-hif-leim values for the DS WAF. The value is short-lived (the
// endpoint advertises x-hif-ttl, typically 600s), so a value captured during
// login is already stale by the time a completion runs. Fetch it lazily and
// cache it for slightly less than the advertised TTL.
//
// Best-effort: callers keep their configured fallback header when the fetch
// fails, and nothing here ever throws into the request path.

const HIF_URL = 'https://hif-leim.deepseek.com/query';
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const RENEW_EARLY_MS = 60 * 1000;

let cached = { value: '', expiresAt: 0 };
let inflight = null;

function resetCache() {
    cached = { value: '', expiresAt: 0 };
    inflight = null;
}

async function fetchValue({ fetchImpl, now }) {
    try {
        const resp = await fetchImpl(HIF_URL, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!resp.ok) return '';
        const json = await resp.json();
        const value = json?.data?.biz_data?.value;
        if (typeof value !== 'string' || !value) return '';
        const advertised = Number(resp.headers?.get?.('x-hif-ttl'));
        const ttlMs = Number.isFinite(advertised) && advertised > 0 ? advertised * 1000 : DEFAULT_TTL_MS;
        cached = {
            value,
            expiresAt: now() + Math.max(ttlMs - RENEW_EARLY_MS, Math.floor(ttlMs / 2)),
        };
        return value;
    } catch (e) {
        return '';
    }
}

// Return the cached value, fetching a fresh one when it has expired. A single
// in-flight request is shared by concurrent completions.
function getHifValue({ fetchImpl = fetch, now = Date.now } = {}) {
    if (cached.value && now() < cached.expiresAt) return Promise.resolve(cached.value);
    if (!inflight) {
        inflight = fetchValue({ fetchImpl, now }).finally(() => { inflight = null; });
    }
    return inflight;
}

// Update the headers used by the next upstream call. The captured login value
// stays in place when a fresh fetch is unavailable.
async function refreshHifHeaders(headers, opts) {
    const value = await getHifValue(opts);
    if (value && headers) headers['x-hif-leim'] = value;
    return value;
}

module.exports = { getHifValue, refreshHifHeaders, resetCache };
