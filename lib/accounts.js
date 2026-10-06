'use strict';
// Account pool state: loading auth configs, least-recently-used selection,
// sticky per-session accounts and cooldown bookkeeping. The rotation logic can
// be unit-tested without starting the HTTP server.
//
// Singleton module: it owns the mutable `accounts` array. Callers get the
// live array via `getAccounts()`; test helpers can replace it via `_setAccounts`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { parseRetryAfterMs } = require('./account-status');
const { createTypedError, typeForStatus } = require('./http');
const config = require('./config');

// Read the account-config env through lib/config.js so there is a single
// source of truth. Values are read lazily at call time (not snapshotted at
// load).

const accounts = [];

// Upstream request budget window: one hour. The cap itself lives in config
// (accountMaxRequestsPerHour) so it can be tuned without a code change.
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

function getAccounts() { return accounts; }
function getAccountById(id) { return accounts.find(a => a.id === id); }

// Stable account id derived from token+cookie. Using a content hash instead of
// a load-order index keeps the id bound to the credentials when auth files are
// added/removed/reordered, so a session's sticky `accountId` never silently
// points at a different account. The same hash already keys the
// upload cache (see upstream.js `uploadCacheKey`), so ids stay consistent.
function accountIdFromCredentials(cfg) {
    const token = String(cfg?.token || '');
    const cookie = String(cfg?.cookie || '');
    return crypto.createHash('sha256').update(`${token}\u0000${cookie}`).digest('hex').slice(0, 16);
}

// Build the shared request headers for one account config. The argument is
// required: defaulting it to the first loaded account silently produced a
// header set for the wrong account when called without arguments.
function buildBaseHeaders(accountConfig) {
    const cfg = accountConfig || {};
    const { clientLocale, clientTimezoneOffset } = config.get();
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.0",
        // Per-account `locale` / `timezone_offset` override the DS_CLIENT_*
        // defaults so accounts from different regions can pin their identity.
        // Use `??` (not `||`) so a legitimate falsy override is honored: an
        // account at UTC sets `timezone_offset: 0`, which `||` would silently
        // replace with the global default.
        "x-client-locale": cfg.locale ?? clientLocale,
        "x-client-timezone-offset": String(cfg.timezone_offset ?? clientTimezoneOffset),
        "x-app-version": "2.0.0",
        "Authorization": `Bearer ${cfg.token || ''}`,
        "x-hif-dliq": cfg.hifDliq || '',
        "x-hif-leim": cfg.hifLeim || '',
        "Origin": `https://${config.get().remoteHost}`,
        "Referer": `https://${config.get().remoteHost}`,
        "Cookie": cfg.cookie || '',
        "Content-Type": "application/json",
    };
}

function discoverAuthPaths() {
    const { authDir } = config.get();
    if (!authDir) return [];
    try {
        return fs.readdirSync(authDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .map(f => path.join(authDir, f));
    } catch (e) {
        console.error(`[DS-API] Could not read DS_AUTH_DIR: ${e.message}`);
        return [];
    }
}

function loadDSConfig({ fatal = true } = {}) {
    accounts.length = 0;
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            // Named `authConfig` (not `config`) so it does not shadow the
            // module-level `./config` import used elsewhere in this function.
            const authConfig = JSON.parse(raw);
            // Reject configs missing credentials up front instead of loading a
            // dead account that only fails later in hasAvailableAccount().
            if (!authConfig || typeof authConfig !== 'object' || !authConfig.token || !authConfig.cookie) {
                const missing = [];
                if (!authConfig?.token) missing.push('token');
                if (!authConfig?.cookie) missing.push('cookie');
                console.error(`[DS-API] Skipping auth config ${file}: missing ${missing.join(' and ')}`);
                continue;
            }
            const id = accountIdFromCredentials(authConfig);
            // Skip duplicate credentials: with a content-addressed id, two files
            // holding the same token+cookie would collapse into one id and make
            // the sticky/LRU bookkeeping ambiguous.
            if (accounts.some(a => a.id === id)) {
                console.log(`[DS-API] Skipping ${file}: duplicate credentials (id=${id})`);
                continue;
            }
            accounts.push({ id, file, config: authConfig, headers: buildBaseHeaders(authConfig), cooldownUntil: 0, failures: 0, lastUsedAt: 0, requestCount: 0, requestWindowStart: 0, nextCompletionAt: 0 });
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => `id=${a.id}`).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected *.json files in ${config.get().authDir || '(unset DS_AUTH_DIR)'}`);
        process.exit(1);
    }
    return false;
}

function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }

// Diagnose the auth-directory setup at startup so a misconfiguration surfaces
// immediately instead of as a confusing 503 on the first request. Returns a
// structured report rather than logging directly, so the check is unit-testable
// and index.js can decide how loudly to complain. Purely advisory: it never
// throws, so a server with no accounts still starts (every request then fails
// with the existing 503 no_auth error).
//
// Call it AFTER loadDSConfig() so `getAccounts()` reflects what actually loaded.
function auditAuthDir() {
    const { authDir } = config.get();
    if (!authDir) {
        return { level: 'error', reason: 'unset', message: 'DS_AUTH_DIR is not set; no auth accounts can be loaded. Set it to a directory of *.json auth configs (see .env.example) and re-run `npm run auth`.' };
    }
    let stat;
    try {
        stat = fs.statSync(authDir);
    } catch (e) {
        return { level: 'error', reason: 'missing', message: `DS_AUTH_DIR=${authDir} does not exist or is not accessible (${e.message}). Re-run \`npm run auth\` to create it.` };
    }
    if (!stat.isDirectory()) {
        return { level: 'error', reason: 'not-a-directory', message: `DS_AUTH_DIR=${authDir} is not a directory.` };
    }
    const paths = discoverAuthPaths();
    if (paths.length === 0) {
        return { level: 'warn', reason: 'no-configs', message: `DS_AUTH_DIR=${authDir} contains no *.json auth configs. Run \`npm run auth\` or add one; every request will 503 until then.` };
    }
    const loaded = getAccounts().length;
    if (loaded === 0) {
        return { level: 'error', reason: 'all-invalid', message: `DS_AUTH_DIR=${authDir} has ${paths.length} *.json file(s) but none loaded (see the messages above). Every request will 503 until a valid config is added.` };
    }
    return { level: 'ok', reason: 'ok', message: `DS_AUTH_DIR=${authDir}: ${loaded} auth account(s) loaded.` };
}

// Select the account for a session, preferring the sticky account if it is
// still healthy. On a broken sticky account the remote session is reset (via
// the injected resetRemoteSession) so the caller does not keep a session bound
// to a dead account.
/**
 * @param {any} session
 * @param {{ resetRemoteSession?: (session: any) => void }} [opts]
 */
function selectAccountForSession(session, { resetRemoteSession } = {}) {
    const now = Date.now();
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.config.token && sticky.config.cookie && sticky.cooldownUntil <= now) {
            sticky.lastUsedAt = now;
            return sticky;
        }
        if (resetRemoteSession) resetRemoteSession(session);
        session.accountId = null;
    }
    const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now);
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
            // Use the shared 429 -> rate_limit_error mapping so this path and
            // the recovery loop's "all accounts cooling" body agree on the type
            // (previously it was the short 'rate_limit' here and
            // 'rate_limit_error' there).
            throw createTypedError(
                typeForStatus(429), 429,
                `All auth accounts are cooling down. Retry in ~${waitSec}s or add a fresh account config.`,
                { retryAfter: waitSec },
            );
        }
        // 'no_auth' is proxy-specific (no credentials configured at all), not a
        // mapping of an upstream status, so it keeps its own type.
        throw createTypedError('no_auth', 503, 'No valid auth accounts.');
    }
    // Least-recently-used: prefer the account that has gone unused the longest
    // so load spreads evenly without a shared cursor. Array#sort is stable, so
    // the load order stays a deterministic tie-breaker for never-used accounts
    // (lastUsedAt === 0).
    const account = ready.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    account.lastUsedAt = now;
    session.accountId = account.id;
    return account;
}

function markAccountFailure(account, status, reason = '', retryAfterRaw = null) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : config.get().accountCooldownMs;
        // Never shorten an existing cooldown (e.g. an hourly-cap park): take the
        // later of the two so a short failure window cannot re-admit an account
        // that is still over its request budget.
        account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + cooldownMs);
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
    }
}

// Cool down an account after a non-HTTP failure (malformed tool markup, empty
// response, …) so the next attempt picks a different account instead of
// hammering the same one. Uses the same cooldown window as HTTP failures.
function markAccountBroken(account, reason = '', cooldownMs = config.get().accountCooldownMs) {
    if (!account) return;
    account.failures++;
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + Math.max(1000, cooldownMs));
    console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after ${reason || 'recoverable failure'}`);
}

// Record one upstream request against the account's hourly budget. When the
// cap (config.accountMaxRequestsPerHour) is reached the account is parked until
// the current window rolls over, so the next selectAccountForSession() rotates
// to a different account. A limit of 0 disables the cap entirely.
//
// Every call to upstream.dsFetch() (PoW challenge, session create, completion,
// uploads, fetch_files) counts as one upstream request, matching how the DS
// rate limit is actually consumed.
function recordAccountRequest(account, now = Date.now()) {
    if (!account) return;
    const limit = config.get().accountMaxRequestsPerHour;
    if (!limit) return;
    // requestWindowStart === 0 means "no window started yet" (fresh account or
    // post-reset), so the first request opens the window at `now`.
    if (!account.requestWindowStart || now - account.requestWindowStart >= REQUEST_WINDOW_MS) {
        account.requestWindowStart = now;
        account.requestCount = 0;
    }
    account.requestCount++;
    if (account.requestCount >= limit) {
        const resetAt = account.requestWindowStart + REQUEST_WINDOW_MS;
        if (resetAt > account.cooldownUntil) {
            account.cooldownUntil = resetAt;
            console.log(`[account:${account.id}] hourly request cap reached (${account.requestCount}/${limit}); rotating until ${new Date(resetAt).toISOString()}`);
        }
    }
}

// Throttle: space completions to the SAME account so a burst cannot trip the
// upstream per-frequency rate limit before the hourly cap is reached. Returns
// true when a slot was reserved, false when the caller should abort (client
// gone, or the wait would blow the deadline).
//
// The slot is RESERVED before sleeping (not after), so N concurrent callers on
// one account queue up at intervalMs steps instead of all waking at the same
// instant and racing. The reservation is intentionally NOT rolled back when the
// caller aborts, to avoid re-introducing the herd.
//
// Called by the session layer BEFORE the PoW challenge is solved: the
// X-DS-PoW-Response header is time/nonce-bound, so it must be created right
// before the request goes out, not before a potentially multi-second wait.
async function waitForCompletionSlot(account, {
    intervalMs = config.get().accountMinCompletionIntervalMs,
    deadlineHit = () => false,
    clientGone = () => false,
    maxWaitMs = config.get().requestDeadlineMs,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    now = () => Date.now(),
} = {}) {
    if (!account || !intervalMs) return true;
    const start = now();
    const target = Math.max(account.nextCompletionAt || 0, start);
    // Reserve immediately so concurrent callers queue instead of racing.
    account.nextCompletionAt = target + intervalMs;
    const waitMs = target - start;
    if (waitMs > 0) {
        if (clientGone() || deadlineHit() || waitMs > maxWaitMs) return false;
        await sleep(waitMs);
    }
    if (clientGone() || deadlineHit()) return false;
    return true;
}

// True when at least one configured account is usable right now.
function hasAvailableAccount() {
    const now = Date.now();
    return accounts.some(a => a.config.token && a.config.cookie && a.cooldownUntil <= now);
}

// Wait until at least one account is usable again, or `deadlineHit()` returns
// true, or `maxWaitMs` elapses. The return value is always the *current*
// availability (i.e. `hasAvailableAccount()`), so callers can use it directly
// and do not need to re-check availability themselves: `true` means "an account
// is ready, rotate now", `false` means "still nothing available". Polls at a
// bounded interval so callers keep rotating instead of failing the request
// during short cooldowns.
async function waitForAvailableAccount(deadlineHit = () => false, { maxWaitMs = 30000, pollMs = 250 } = {}) {
    if (hasAvailableAccount()) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
        if (deadlineHit()) break;
        await new Promise(r => setTimeout(r, pollMs));
        if (hasAvailableAccount()) return true;
    }
    return hasAvailableAccount();
}

// Reset all runtime cooldown/failure state.
function resetAccountState() {
    for (const a of accounts) { a.cooldownUntil = 0; a.failures = 0; a.lastUsedAt = 0; a.requestCount = 0; a.requestWindowStart = 0; a.nextCompletionAt = 0; }
}

module.exports = {
    accountIdFromCredentials,
    getAccounts,
    getAccountById,
    buildBaseHeaders,
    discoverAuthPaths,
    loadDSConfig,
    hasAuthConfig,
    auditAuthDir,
    selectAccountForSession,
    markAccountFailure,
    markAccountBroken,
    recordAccountRequest,
    waitForCompletionSlot,
    hasAvailableAccount,
    waitForAvailableAccount,
    resetAccountState,
};
