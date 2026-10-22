'use strict';

const config = require('./config');

const UPLOAD_CACHE_TTL_MS = config.get().uploadCacheTtlMs;

const cache = new Map();

function get(key) { return cache.get(key); }
function has(key) { return cache.has(key); }
function set(key, value) { cache.set(key, value); }
function size() { return cache.size; }
function getCache() { return cache; }

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
