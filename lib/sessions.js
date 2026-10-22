'use strict';

const config = require('./config');

const SESSION_TTL_MS = config.get().sessionTtlMs;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSIONS = config.get().maxSessions;

const EPHEMERAL_SWEEP_MAX_IDLE_MS = 10 * 60 * 1000;

const uploadCache = require('./upload-cache');
const { createTypedError } = require('./http');
const { debugLog } = require('./debug');

const sessions = new Map();

let deleteRemoteSession = null;

function setRemoteSessionDeleter(fn) { deleteRemoteSession = typeof fn === 'function' ? fn : null; }

function getSessions() { return sessions; }
function getSessionCount() { return sessions.size; }

function normalizeAgentId(agentId) {
    agentId = String(agentId);
    if (agentId.length > MAX_SESSION_ID_LENGTH) {
        agentId = Array.from(agentId).slice(0, MAX_SESSION_ID_LENGTH).join('');
    }
    return agentId;
}

function deleteSession(agentId) { return sessions.delete(normalizeAgentId(agentId)); }

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,

        sentKeys: new Set(),

        lastMessagesLength: 0,

        contextTokens: 0,

        tokenRateSamples: [],

        peakTokensPerMinute: 0,

        lastActivityAt: Date.now(),
    };
}

function resetRemoteSession(session, { releaseAccount = false } = {}) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };

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

    if (releaseAccount) session.accountId = null;
    return failed;
}

const TOKEN_RATE_WINDOW_MS = 60 * 1000;

function tokenRatePressure(session, limitPerMin, now = Date.now()) {
    if (!session || !(limitPerMin > 0)) return 0;
    const samples = session.tokenRateSamples;
    if (!Array.isArray(samples) || samples.length < 2) return 0;
    const prev = samples[samples.length - 2];
    const last = samples[samples.length - 1];

    if (now - last.at > TOKEN_RATE_WINDOW_MS) return 0;
    const spanMs = Math.max(1, last.at - prev.at);
    const deltaTokens = Math.max(0, last.tokens - prev.tokens);
    const tokensPerMinute = deltaTokens * 60000 / spanMs;
    if (tokensPerMinute <= limitPerMin) return 0;

    return Math.min(1, (tokensPerMinute - limitPerMin) / limitPerMin);
}

function recordTokenRate(session, tokens, now = Date.now()) {
    if (!session || typeof tokens !== 'number') return null;
    if (!Array.isArray(session.tokenRateSamples)) session.tokenRateSamples = [];
    const prev = session.tokenRateSamples.length
        ? session.tokenRateSamples[session.tokenRateSamples.length - 1]
        : null;

    const deltaTokens = prev ? Math.max(0, tokens - prev.tokens) : tokens;

    const spanMs = prev ? Math.max(1, now - prev.at) : 0;
    session.tokenRateSamples.push({ at: now, tokens });

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

    const lastActive = session.lastActivityAt || session.createdAt;
    if (lastActive && now - lastActive > sessionTtlMs) reason = 'session_ttl';
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}

function getOrCreateAgentSession(agentId) {
    agentId = normalizeAgentId(agentId);
    if (!sessions.has(agentId)) {
        if (sessions.size >= config.get().maxSessions) {

            throw createTypedError('too_many_sessions', 503, 'Too many active sessions; retry later.');
        }
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    if (!(session.sentKeys instanceof Set)) session.sentKeys = new Set();
    if (typeof session.contextTokens !== 'number') session.contextTokens = 0;
    if (!Array.isArray(session.tokenRateSamples)) session.tokenRateSamples = [];
    if (typeof session.peakTokensPerMinute !== 'number') session.peakTokensPerMinute = 0;

    return session;
}

function resetAllRemoteSessions() {
    let attempted = 0;
    for (const session of sessions.values()) {
        if (!session.id) continue;
        attempted++;
        resetRemoteSession(session);
    }
    return attempted;
}

function sweepIdleSessions(maxIdleMs = config.get().sessionTtlMs * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {

        const idleLimit = session.ephemeral ? EPHEMERAL_SWEEP_MAX_IDLE_MS : maxIdleMs;
        if (now - (session.lastActivityAt || 0) > idleLimit) {

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
    deleteSession,
    createSession,
    setRemoteSessionDeleter,
    resetRemoteSession,
    resetAllRemoteSessions,
    prepareSessionForPrompt,
    getOrCreateAgentSession,
    sweepIdleSessions,
};
