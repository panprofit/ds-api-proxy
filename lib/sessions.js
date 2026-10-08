'use strict';
// Per-agent session registry. Session lifecycle (sticky account, parent
// message id, TTL rollover) can be unit-tested without starting the
// HTTP server.
//
// Singleton module: owns the mutable `sessions` Map. The upload cache lives in
// ./upload-cache; this module only triggers its sweep alongside idle sessions.

// Config is read lazily at call time. The exported constants below are a
// load-time snapshot kept for tests/back-compat.
const config = require('./config');

const SESSION_TTL_MS = config.get().sessionTtlMs;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSIONS = config.get().maxSessions;

// Upload caching lives in ./upload-cache; sessions only calls its sweep() to
// purge stale entries alongside idle sessions. Access the cache directly from
// ./upload-cache rather than re-exporting it here.
const uploadCache = require('./upload-cache');
const { createTypedError } = require('./http');
const { debugLog } = require('./debug');

const sessions = new Map();

// Injected by index.js: (accountId, sessionId) => void. Best-effort upstream
// deletion of the remote session before it is forgotten locally. Kept as an
// injected hook so this module stays free of network/upstream dependencies.
let deleteRemoteSession = null;

// Register the deleter used by resetRemoteSession().
function setRemoteSessionDeleter(fn) { deleteRemoteSession = typeof fn === 'function' ? fn : null; }

function getSessions() { return sessions; }
function getSessionCount() { return sessions.size; }

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        // Consecutive remote-session recreations caused by malformed tool-call
        // markup. Reset on a successful completion; once it reaches
        // maxSessionResetsPerAccount the account is rotated instead.
        malformedResets: 0,
        // Fingerprints of user messages / tool results already forwarded upstream.
        // Prevents re-sending an unchanged turn when an existing remote session is reused.
        sentKeys: new Set(),
        // Estimated size of the full context currently held by the remote
        // session (system prompt + tools + entire history), refreshed on every
        // successful completion. Reset whenever the remote session is recreated.
        contextTokens: 0,
        // Rolling samples of { at, tokens } recorded on every successful
        // completion. DS rate-limits by request/throughput over a window, not
        // by absolute session size, so `tokensPerMinute()` needs recent samples
        // to expose the burn rate. Bounded ring: only the last
        // TOKEN_RATE_WINDOW_MS / TOKEN_RATE_MIN_INTERVAL_MS worth is kept.
        tokenRateSamples: [],
        // Highest tokens/min observed in this session, for at-a-glance logs.
        peakTokensPerMinute: 0,
        // Wall-clock time of the last ACTUAL conversation activity (remote
        // session created, or a turn completed). NOT bumped by
        // getOrCreateAgentSession(): a lookup is not activity, and bumping it
        // there would mask idle time. Drives the idle TTL in
        // prepareSessionForPrompt().
        lastActivityAt: Date.now(),
    };
}

function resetRemoteSession(session, { releaseAccount = false } = {}) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    // Delete the upstream session BEFORE dropping the local id, otherwise the
    // remote session leaks. Fire-and-forget: deletion is best-effort and must
    // never block the synchronous reset path.
    if (deleteRemoteSession && session.id) {
        try { deleteRemoteSession(session.accountId, session.id); }
        catch (e) { debugLog(console.error, '[DS-API] remote session delete failed:', e.message); }
    }
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentKeys = new Set();
    session.contextTokens = 0;
    session.tokenRateSamples = [];
    session.peakTokensPerMinute = 0;
    // Releasing the sticky account makes the next selectAccountForSession()
    // pick via least-recently-used instead of re-selecting the just-failed
    // account (it was just touched, so it is the most recently used).
    if (releaseAccount) session.accountId = null;
    return failed;
}

// Rolling token-rate window. DS throttles by throughput over a recent window
// (a dense ~5s cadence trips it in minutes, a sparse one runs for hours), so
// the useful signal is tokens burned per minute, not the session total.
const TOKEN_RATE_WINDOW_MS = 60 * 1000;

// How "hot" the session is relative to a caller-supplied tokens/min limit,
// as a 0..1 pressure signal the completion throttle can stretch its pause by.
//
// Uses the MOST RECENT sample, not `peakTokensPerMinute`: the peak is
// historical and would keep the throttle stretched forever after a single
// burst, long after the burn rate fell back to idle. Returns 0 when there is
// no recent activity or no limit is configured, so an idle session never
// slows the next request. The caller owns the limit; this module only measures.
function tokenRatePressure(session, limitPerMin, now = Date.now()) {
    if (!session || !(limitPerMin > 0)) return 0;
    const samples = session.tokenRateSamples;
    if (!Array.isArray(samples) || samples.length < 2) return 0;
    const prev = samples[samples.length - 2];
    const last = samples[samples.length - 1];
    // A stale window (nothing recorded inside TOKEN_RATE_WINDOW_MS) means the
    // session has gone quiet, so there is no pressure to apply.
    if (now - last.at > TOKEN_RATE_WINDOW_MS) return 0;
    const spanMs = Math.max(1, last.at - prev.at);
    const deltaTokens = Math.max(0, last.tokens - prev.tokens);
    const tokensPerMinute = deltaTokens * 60000 / spanMs;
    if (tokensPerMinute <= limitPerMin) return 0;
    // 1.0 at exactly 2x the limit and beyond; linear in between. Capped so a
    // runaway burst cannot stretch the interval without bound.
    return Math.min(1, (tokensPerMinute - limitPerMin) / limitPerMin);
}

// Record a completed turn's context size and return the current burn rate.
// Called on every successful completion. `tokens` is the (estimated) full
// context the remote session now holds; samples older than the window are
// dropped. Returns { tokensPerMinute, deltaTokens, windowMs }.
function recordTokenRate(session, tokens, now = Date.now()) {
    if (!session || typeof tokens !== 'number') return null;
    if (!Array.isArray(session.tokenRateSamples)) session.tokenRateSamples = [];
    const prev = session.tokenRateSamples.length
        ? session.tokenRateSamples[session.tokenRateSamples.length - 1]
        : null;
    // Burn is the delta since the previous turn. Measuring from the oldest
    // sample in the window would return 0 for the very first sample (oldest IS
    // the sample just pushed) and would understate a burst that follows an idle
    // gap. Negative deltas (retry re-sending the same context) carry no burn
    // signal, so clamp to 0.
    const deltaTokens = prev ? Math.max(0, tokens - prev.tokens) : tokens;
    // No previous sample means there is no interval to measure a rate over:
    // report 0 rather than dividing by a synthetic 1ms span (which would
    // fabricate a huge, meaningless rate for the session's first turn).
    const spanMs = prev ? Math.max(1, now - prev.at) : 0;
    session.tokenRateSamples.push({ at: now, tokens });
    // Drop samples that have fallen out of the rolling window. Keep at least
    // one sample (the current one) so the window is never empty; `> 1` (not
    // `> 2`) is what allows the stale sample to actually be removed.
    const cutoff = now - TOKEN_RATE_WINDOW_MS;
    while (session.tokenRateSamples.length > 1 && session.tokenRateSamples[0].at < cutoff) {
        session.tokenRateSamples.shift();
    }
    const tokensPerMinute = spanMs > 0 ? Math.round(deltaTokens * 60000 / spanMs) : 0;
    if (tokensPerMinute > session.peakTokensPerMinute) session.peakTokensPerMinute = tokensPerMinute;
    return { tokensPerMinute, deltaTokens, windowMs: spanMs };
}

function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.id) return null;
    const { sessionTtlMs } = config.get();
    let reason = null;
    // Idle TTL: roll the remote session over only when it has seen no
    // conversation activity for `sessionTtlMs`. Anchoring on lastActivityAt
    // (not createdAt) keeps a session that is actively exchanging turns alive
    // indefinitely, and only recycles genuinely idle ones. Fall back to
    // createdAt for sessions created before lastActivityAt existed.
    const lastActive = session.lastActivityAt || session.createdAt;
    if (lastActive && now - lastActive > sessionTtlMs) reason = 'session_ttl';
    if (!reason) return null;
    // A TTL rollover starts a brand-new logical conversation, so the
    // consecutive malformed-markup counter must not carry over to it (that
    // would rotate the account prematurely). Note: resetRemoteSession() itself
    // deliberately leaves malformedResets untouched because the recovery loop
    // increments it and then resets the session on the SAME account.
    session.malformedResets = 0;
    return { reason, ...resetRemoteSession(session) };
}

function getOrCreateAgentSession(agentId) {
    agentId = String(agentId);
    // Truncate by code points, not UTF-16 units: `String#slice` can split a
    // surrogate pair, producing a lone surrogate that is no longer valid UTF-8
    // (and collides with a different id in `sessions`).
    if (agentId.length > MAX_SESSION_ID_LENGTH) {
        agentId = Array.from(agentId).slice(0, MAX_SESSION_ID_LENGTH).join('');
    }
    if (!sessions.has(agentId)) {
        if (sessions.size >= config.get().maxSessions) {
            // Proxy-specific type (not an upstream-status mapping), but still
            // built through the shared helper so every thrown error carries the
            // same { type, status } shape.
            throw createTypedError('too_many_sessions', 503, 'Too many active sessions; retry later.');
        }
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    if (!(session.sentKeys instanceof Set)) session.sentKeys = new Set();
    if (typeof session.contextTokens !== 'number') session.contextTokens = 0;
    if (!Array.isArray(session.tokenRateSamples)) session.tokenRateSamples = [];
    if (typeof session.peakTokensPerMinute !== 'number') session.peakTokensPerMinute = 0;
    // Deliberately do NOT touch lastActivityAt here: merely resolving the
    // session for a request is not conversation activity. It is refreshed when
    // a remote session is created and when a turn completes (see sse.js /
    // upstream-session.js), which is what the idle TTL measures.
    return session;
}

// Delete every registered session's upstream counterpart and clear local
// state. Called during graceful shutdown so no remote session is left behind
// on any account. Returns the number of remote sessions a delete was attempted
// for (i.e. sessions that had a remote id). Best-effort: the deleter itself is
// fire-and-forget, so this returns before deletions settle.
function resetAllRemoteSessions() {
    let attempted = 0;
    for (const session of sessions.values()) {
        if (!session.id) continue;
        attempted++;
        resetRemoteSession(session);
    }
    return attempted;
}

// Drop sessions idle for longer than `maxIdleMs` and stale upload-cache
// entries. Returns the number of removed sessions (upload sweeps are logged).
//
// An idle session is discarded locally, but its upstream counterpart must be
// deleted first: unlike shutdown, where resetAllRemoteSessions() handles this,
// a plain `sessions.delete()` would leak the remote session on the account
// forever (the next request for the same agent starts a fresh remote session
// and nothing ever references the old id again).
function sweepIdleSessions(maxIdleMs = config.get().sessionTtlMs * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) {
            // Fire-and-forget upstream delete (the injected deleter is
            // best-effort and never throws into this path). Safe when the
            // session has no remote id yet — resetRemoteSession() no-ops then.
            resetRemoteSession(session);
            sessions.delete(agentId);
            removed++;
        }
    }
    const uploadsRemoved = uploadCache.sweep();
    if (removed || uploadsRemoved) console.log(`[DS-API] swept ${removed} idle session(s) (${sessions.size} remain), ${uploadsRemoved} stale upload(s) (${uploadCache.size()} remain)`);
    return removed;
}

module.exports = {
    SESSION_TTL_MS,
    TOKEN_RATE_WINDOW_MS,
    MAX_SESSION_ID_LENGTH,
    MAX_SESSIONS,
    recordTokenRate,
    tokenRatePressure,
    getSessions,
    getSessionCount,
    createSession,
    setRemoteSessionDeleter,
    resetRemoteSession,
    resetAllRemoteSessions,
    prepareSessionForPrompt,
    getOrCreateAgentSession,
    sweepIdleSessions,
};
