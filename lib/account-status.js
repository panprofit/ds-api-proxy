'use strict';
// Account retry helpers. Kept separate from ./accounts so the mutable
// account pool does not have to import the whole core facade.

function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}

module.exports = {
    parseRetryAfterMs,
};
