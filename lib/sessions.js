'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

const SESSION_TTL_MS = config.get().sessionTtlMs;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSIONS = config.get().maxSessions;

const EPHEMERAL_SWEEP_MAX_IDLE_MS = 10 * 60 * 1000;

const uploadCache = require('./upload-cache');
const { createTypedError } = require('./http');
const { debugLog } = require('./debug');

const sessions = new Map();

const remoteSessions = new Map();
let journalLoaded = false;
let journalLoadedPath = null;

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

function journalFile() { return config.get().sessionJournalPath; }

function loadJournal() {
    const file = journalFile();
    if (journalLoaded && journalLoadedPath === file) return;
    journalLoaded = true;
    journalLoadedPath = file;
    remoteSessions.clear();
    let raw;
    try { raw = fs.readFileSync(journalFile(), 'utf8'); }
    catch { return; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return; }
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
        if (entry && typeof entry.id === 'string' && entry.id) {
            remoteSessions.set(entry.id, { id: entry.id, accountId: entry.accountId || null });
        }
    }
}

function flushJournal() {
    const file = journalFile();
    try {
        if (remoteSessions.size === 0) {
            fs.rmSync(file, { force: true });
            return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify([...remoteSessions.values()]));
    } catch (e) {
        debugLog(console.error, '[DS-API] session journal write failed:', e.message);
    }
}

function noteRemoteSession(accountId, sessionId) {
    if (!sessionId) return;
    loadJournal();
    remoteSessions.set(sessionId, { id: sessionId, accountId: accountId || null });
    flushJournal();
}

function forgetRemoteSession(sessionId) {
    if (!sessionId) return;
    loadJournal();
    if (!remoteSessions.delete(sessionId)) return;
    flushJournal();
}

function takeOrphanedRemoteSessions() {
    loadJournal();
    const orphans = [...remoteSessions.values()];
    remoteSessions.clear();
    flushJournal();
    return orphans;
}

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
        forgetRemoteSession(session.id);
    }
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentKeys = new Set();
    session.contextTokens = 0;
    delete session.throttleParentId;
    session.throttleStreak = 0;

    if (releaseAccount) session.accountId = null;
    return failed;
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
    MAX_SESSION_ID_LENGTH,
    MAX_SESSIONS,
    getSessions,
    getSessionCount,
    deleteSession,
    createSession,
    setRemoteSessionDeleter,
    noteRemoteSession,
    forgetRemoteSession,
    takeOrphanedRemoteSessions,
    resetRemoteSession,
    resetAllRemoteSessions,
    prepareSessionForPrompt,
    getOrCreateAgentSession,
    sweepIdleSessions,
};
