'use strict';
// Upload cache: maps an account+file signature to the DS file id so identical
// attachments are not uploaded twice. Owned by its own module so the network
// layer (./upstream) does not have to reach into ./sessions.

const config = require('./config');

// Load-time snapshot kept for tests/back-compat; sweep() reads the live value
// via config.get().
const UPLOAD_CACHE_TTL_MS = config.get().uploadCacheTtlMs;

const cache = new Map(); // cacheKey -> { id, filename, mime, cachedAt }

function get(key) { return cache.get(key); }
function has(key) { return cache.has(key); }
function set(key, value) { cache.set(key, value); }
function size() { return cache.size; }
function getCache() { return cache; }

// Drop entries older than the TTL. Returns the number removed.
function sweep(now = Date.now(), ttlMs = config.get().uploadCacheTtlMs) {
    let removed = 0;
    for (const [key, entry] of cache) {
        if (!entry || now - (entry.cachedAt || 0) > ttlMs) { cache.delete(key); removed++; }
    }
    return removed;
}

module.exports = {
    UPLOAD_CACHE_TTL_MS,
    get,
    has,
    set,
    size,
    getCache,
    sweep,
};
