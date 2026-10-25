'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { parseRetryAfterMs } = require('./account-status');
const { createTypedError, typeForStatus } = require('./http');
const config = require('./config');

const accounts = [];

const ACCOUNT_STATE_FILE = '.account-state.json';

function accountStatePath() {
    const { authDir } = config.get();
    return path.join(authDir, ACCOUNT_STATE_FILE);
}

function loadAccountState() {
    const empty = { cooldowns: {}, lastUsedAt: {} };
    const file = accountStatePath();
    if (!file) return empty;
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {

        if (e.code !== 'ENOENT') console.error(`[DS-API] Could not read ${ACCOUNT_STATE_FILE}: ${e.message}`);
        return empty;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.error(`[DS-API] Ignoring corrupt ${ACCOUNT_STATE_FILE}: ${e.message}`);
        return empty;
    }
    if (!parsed || typeof parsed !== 'object') return empty;
    const now = Date.now();
    const cooldowns = {};
    const rawCooldowns = parsed.cooldowns && typeof parsed.cooldowns === 'object' ? parsed.cooldowns : {};
    for (const [id, until] of Object.entries(rawCooldowns)) {
        if (typeof until === 'number' && until > now) cooldowns[id] = until;
    }
    const lastUsedAt = {};
    const rawLastUsed = parsed.lastUsedAt && typeof parsed.lastUsedAt === 'object' ? parsed.lastUsedAt : {};
    for (const [id, at] of Object.entries(rawLastUsed)) {
        if (typeof at === 'number') lastUsedAt[id] = at;
    }
    return { cooldowns, lastUsedAt };
}

let lastPersistedState = null;

function serializeAccountState() {
    const now = Date.now();
    const cooldowns = {};
    const lastUsedAt = {};
    for (const a of accounts) {

        if (!a.authExpired && a.cooldownUntil > now) cooldowns[a.id] = a.cooldownUntil;
        if (a.lastUsedAt > 0) lastUsedAt[a.id] = a.lastUsedAt;
    }
    return JSON.stringify({ version: 1, cooldowns, lastUsedAt }, null, 2);
}

function persistAccountState() {
    const file = accountStatePath();
    if (!file) return;
    const serialized = serializeAccountState();
    if (serialized === lastPersistedState) return;
    try {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, serialized, { mode: 0o600 });
        fs.renameSync(tmp, file);
        lastPersistedState = serialized;
    } catch (e) {
        console.error(`[DS-API] Could not write ${ACCOUNT_STATE_FILE}: ${e.message}`);
    }
}

let stateDirty = false;
let stateFlushTimer = null;

function markStateDirty() {
    stateDirty = true;
    if (stateFlushTimer) return;
    const flushMs = config.get().accountStateFlushMs;
    if (!flushMs) return;
    stateFlushTimer = setInterval(() => {
        if (!stateDirty) return;
        stateDirty = false;
        persistAccountState();
    }, flushMs);

    if (typeof stateFlushTimer.unref === 'function') stateFlushTimer.unref();
}

function flushAccountState() {
    stateDirty = false;
    persistAccountState();
}

function getAccounts() { return accounts; }
function getAccountById(id) { return accounts.find(a => a.id === id); }

function accountIdFromCredentials(cfg) {
    const token = String(cfg?.token || '');
    const cookie = String(cfg?.cookie || '');
    return crypto.createHash('sha256').update(`${token}\u0000${cookie}`).digest('hex').slice(0, 16);
}

function normalizeAccountEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function accountIdFromEmail(email) {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return '';
    return crypto.createHash('sha256').update(`email\u0000${normalized}`).digest('hex').slice(0, 16);
}

function accountIdForConfig(cfg) {
    return accountIdFromEmail(cfg?.email) || accountIdFromCredentials(cfg);
}

function buildBaseHeaders(accountConfig) {
    const cfg = accountConfig || {};
    const { clientLocale, clientTimezoneOffset } = config.get();
    const origin = `https://${config.get().remoteHost}`;
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.0",

        "x-client-locale": cfg.locale ?? clientLocale,
        "x-client-timezone-offset": String(cfg.timezone_offset ?? clientTimezoneOffset),
        "x-app-version": "2.0.0",
        "Authorization": `Bearer ${cfg.token || ''}`,
        "Origin": origin,
        "Referer": origin,
        "Cookie": cfg.cookie || '',
        "Content-Type": "application/json",
    };
}

function setAccountToken(account, token) {
    if (!account || typeof token !== 'string' || !token) return false;
    if (account.config && account.config.token === token) return false;
    if (account.config) account.config.token = token;
    if (account.headers) account.headers.Authorization = `Bearer ${token}`;

    account.authExpired = false;
    return true;
}

function persistAccountToken(account) {
    const file = account?.file;
    const cfg = account?.config;
    if (!file || !cfg || !cfg.email || !cfg.token) return false;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.error(`[DS-API] Could not persist refreshed token for id=${account.id}: ${e.message}`);
        try { fs.rmSync(tmp, { force: true }); } catch {}
        return false;
    }
}

function discoverAuthPaths() {
    const { authDir } = config.get();
    try {
        return fs.readdirSync(authDir)

            .filter(f => f.endsWith('.json') && f !== ACCOUNT_STATE_FILE)
            .sort()
            .map(f => path.join(authDir, f));
    } catch (e) {
        console.error(`[DS-API] Could not read DS_AUTH_DIR: ${e.message}`);
        return [];
    }
}

function loadDSConfig({ fatal = true } = {}) {
    accounts.length = 0;
    const { cooldowns, lastUsedAt } = loadAccountState();
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');

            const authConfig = JSON.parse(raw);

            if (!authConfig || typeof authConfig !== 'object' || !authConfig.token || !authConfig.cookie) {
                const missing = [];
                if (!authConfig?.token) missing.push('token');
                if (!authConfig?.cookie) missing.push('cookie');
                console.error(`[DS-API] Skipping auth config ${file}: missing ${missing.join(' and ')}`);
                continue;
            }
            const id = accountIdForConfig(authConfig);

            if (accounts.some(a => a.id === id)) {
                console.log(`[DS-API] Skipping ${file}: duplicate account (id=${id})`);
                continue;
            }
            const persistedCooldown = cooldowns[id] || 0;
            const persistedLastUsed = lastUsedAt[id] || 0;
            accounts.push({ id, file, config: authConfig, headers: buildBaseHeaders(authConfig), cooldownUntil: persistedCooldown, failures: 0, lastUsedAt: persistedLastUsed, nextCompletionAt: 0, authExpired: false });
            if (persistedCooldown > Date.now()) {
                console.log(`[DS-API] Restored cooldown for id=${id} until ${new Date(persistedCooldown).toISOString()}`);
            }
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => `id=${a.id}`).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected *.json files in ${config.get().authDir}`);
        process.exit(1);
    }
    return false;
}

function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }

function auditAuthDir() {
    const { authDir } = config.get();
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

/**
 * `forceLru` skips the sticky fast-path entirely: an anonymous request that
 * must start a fresh remote session should never re-pin the just-used account,
 * so the least-recently-used pick is mandatory regardless of session.accountId.
 *
 * @param {any} session
 * @param {{ resetRemoteSession?: (session: any) => void, forceLru?: boolean }} [opts]
 */
function selectAccountForSession(session, { resetRemoteSession, forceLru = false } = {}) {
    const now = Date.now();
    if (forceLru) session.accountId = null;
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.config.token && sticky.config.cookie && !sticky.authExpired && sticky.cooldownUntil <= now) {
            sticky.lastUsedAt = now;
            markStateDirty();
            return sticky;
        }
        if (resetRemoteSession) resetRemoteSession(session);
        session.accountId = null;
    }
    const ready = accounts.filter(a => a.config.token && a.config.cookie && !a.authExpired && a.cooldownUntil <= now);
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie && !a.authExpired).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));

            throw createTypedError(
                typeForStatus(429), 429,
                `All auth accounts are cooling down. Retry in ~${waitSec}s or add a fresh account config.`,
                { retryAfter: waitSec },
            );
        }

        if (accounts.some(a => a.config.token && a.config.cookie && a.authExpired)) {
            throw createTypedError('auth_expired', 401, 'All auth accounts have expired credentials. Re-run `npm run auth` (or `npm run auth:repair`).');
        }

        throw createTypedError('no_auth', 503, 'No valid auth accounts.');
    }

    const account = ready.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    account.lastUsedAt = now;
    markStateDirty();
    session.accountId = account.id;
    return account;
}

function markAccountFailure(account, status, reason = '', retryAfterRaw = null) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : config.get().accountCooldownMs;

        account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + cooldownMs);
        markStateDirty();
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''} [failures=${account.failures}]`);
    }
}

function markAccountBroken(account, reason = '', cooldownMs = config.get().accountCooldownMs) {
    if (!account) return;
    account.failures++;
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + Math.max(1000, cooldownMs));
    markStateDirty();
    console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after ${reason || 'recoverable failure'} [failures=${account.failures}]`);
}

function markAccountAuthExpired(account, reason = 'auth expired / captcha / DS Web API change') {
    if (!account) return;
    account.failures++;
    account.authExpired = true;

    account.cooldownUntil = 0;
    console.log(`[account:${account.id}] auth expired (${reason}); disabled until re-auth [failures=${account.failures}]`);
}

async function waitForCompletionSlot(account, {
    intervalMs = config.get().accountMinCompletionIntervalMs,
    clientGone = () => false,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    now = () => Date.now(),
} = {}) {
    if (!account || !intervalMs) return true;

    const start = now();
    const target = Math.max(account.nextCompletionAt || 0, start);

    account.nextCompletionAt = target + intervalMs;
    const waitMs = target - start;
    if (waitMs > 0) {
        if (clientGone()) return false;
        await sleep(waitMs);
    }
    if (clientGone()) return false;
    return true;
}

function hasAvailableAccount(now = () => Date.now()) {
    const ts = now();
    return accounts.some(a => a.config.token && a.config.cookie && !a.authExpired && a.cooldownUntil <= ts);
}

function earliestAvailabilityDelayMs(now = () => Date.now()) {
    const ts = now();
    let earliest = Infinity;
    for (const a of accounts) {
        if (!a.config.token || !a.config.cookie || a.authExpired) continue;
        const readyAt = Math.max(ts, a.cooldownUntil || 0);
        if (readyAt < earliest) earliest = readyAt;
    }
    return earliest === Infinity ? Infinity : earliest - ts;
}

async function waitForAvailableAccount(shouldStop = () => false, { maxWaitMs = 30000, pollMs = 250, clientGone = () => false, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = {}) {
    if (hasAvailableAccount(now)) return true;
    if (earliestAvailabilityDelayMs(now) > maxWaitMs) return false;
    const startedAt = now();
    while (now() - startedAt < maxWaitMs) {
        if (shouldStop() || clientGone()) break;
        await sleep(pollMs);
        if (hasAvailableAccount(now)) return true;
    }
    return hasAvailableAccount(now);
}

function resetAccountState() {
    for (const a of accounts) { a.cooldownUntil = 0; a.failures = 0; a.lastUsedAt = 0; a.nextCompletionAt = 0; a.authExpired = false; }
}

module.exports = {
    accountIdFromCredentials,
    accountIdFromEmail,
    accountIdForConfig,
    getAccounts,
    getAccountById,
    buildBaseHeaders,
    setAccountToken,
    persistAccountToken,
    discoverAuthPaths,
    loadDSConfig,
    hasAuthConfig,
    auditAuthDir,
    selectAccountForSession,
    markAccountFailure,
    markAccountBroken,
    markAccountAuthExpired,
    waitForCompletionSlot,
    hasAvailableAccount,
    waitForAvailableAccount,
    resetAccountState,
    accountStatePath,
    loadAccountState,
    serializeAccountState,
    persistAccountState,
    flushAccountState,
};
