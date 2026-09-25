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
    // Releasing the sticky account makes the next selectAccountForSession()
    // pick via round-robin instead of re-selecting the just-failed account.
    if (releaseAccount) session.accountId = null;
    return failed;
}

function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.id) return null;
    const { sessionTtlMs } = config.get();
    let reason = null;
    if (session.createdAt && now - session.createdAt > sessionTtlMs) reason = 'session_ttl';
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
    session.lastActivityAt = Date.now();
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
    MAX_SESSION_ID_LENGTH,
    MAX_SESSIONS,
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
