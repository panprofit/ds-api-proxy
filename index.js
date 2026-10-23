#!/usr/bin/env node

const {
    getOrCreateAgentSession, prepareSessionForPrompt,
    resetRemoteSession, sweepIdleSessions, setRemoteSessionDeleter,
    resetAllRemoteSessions, recordTokenRate, tokenRatePressure,
    noteRemoteSession, forgetRemoteSession, takeOrphanedRemoteSessions,
} = require('./lib/sessions');
const {
    selectAccountForSession, markAccountFailure,
    loadDSConfig, auditAuthDir, getAccountById,
    waitForCompletionSlot,
} = require('./lib/accounts');
const {
    dsChatCompletionWithPow, solvePowForPath,
    createRemoteSession, deleteRemoteSession, refreshAccountToken,
} = require('./lib/upstream');
const { readDSResponse } = require('./lib/sse');
const { createUpstreamHttpError } = require('./lib/http');
const { createUpstreamSession } = require('./lib/upstream-session');
const hif = require('./lib/hif');
const { createSemaphore } = require('./lib/semaphore');
const { createServer } = require('./lib/server');
const configModule = require('./lib/config');
const { debugLog } = require('./lib/debug');

const config = configModule.get();
const PORT = config.port;
const HOST = config.host;

const pendingDeletes = new Set();
function trackDelete(promise) {
    pendingDeletes.add(promise);

    promise.catch(() => {}).finally(() => pendingDeletes.delete(promise));
}

function deleteRemoteSessionForAccount(accountId, sessionId) {
    const account = accountId ? getAccountById(accountId) : null;
    if (!account) {
        debugLog(console.log, `[DS-API] no account ${accountId} for remote session ${sessionId}; skipping delete`);
        return Promise.resolve();
    }
    return Promise.resolve(deleteRemoteSession(account, account.headers, sessionId))
        .then(() => forgetRemoteSession(sessionId))
        .catch(e => debugLog(console.error, '[DS-API] remote session delete failed:', e.message));
}

function deleteOrphanedRemoteSessions() {
    const orphans = takeOrphanedRemoteSessions();
    for (const orphan of orphans) {
        trackDelete(deleteRemoteSessionForAccount(orphan.accountId, orphan.id));
    }
    return orphans.length;
}

setRemoteSessionDeleter((accountId, sessionId) => {
    trackDelete(deleteRemoteSessionForAccount(accountId, sessionId));
});

function buildRuntime({ startedAt = Date.now() } = {}) {
    const askDSStream = createUpstreamSession({
        getOrCreateAgentSession,
        prepareSessionForPrompt,
        resetRemoteSession,
        noteRemoteSession,
        recordTokenRate,
        tokenRatePressure,
        selectAccountForSession,
        markAccountFailure,
        solvePowForPath,
        createRemoteSession,
        dsChatCompletionWithPow,
        createUpstreamHttpError,
        waitForCompletionSlot,
        refreshAccountToken,
        refreshClientHeaders: hif.refreshHifHeaders,
    });

    const semaphore = createSemaphore(config.maxConcurrent);

    const requestDeps = { askDSStream, readDSResponse };

    const { server, shutdownCtl, listen } = createServer({
        semaphore,
        requestDeps,
        resetAllRemoteSessions,
        pendingDeletesSize: () => pendingDeletes.size,
        startedAt,
        port: PORT,
        host: HOST,
    });

    return { server, shutdownCtl, listen, semaphore, requestDeps };
}

function auditAuthDirAtStartup() {
    loadDSConfig({ fatal: false });
    const authAudit = auditAuthDir();
    if (authAudit.level === 'ok') console.log(`[DS-API] ${authAudit.message}`);
    else if (authAudit.level === 'warn') console.warn(`[DS-API] WARNING: ${authAudit.message}`);
    else console.error(`[DS-API] ERROR: ${authAudit.message}`);
}

function main() {
    auditAuthDirAtStartup();
    const orphaned = deleteOrphanedRemoteSessions();
    if (orphaned > 0) console.log(`[DS-API] deleting ${orphaned} remote session(s) left behind by a previous crash`);
    const runtime = buildRuntime({ startedAt: Date.now() });

    if (configModule.get().corsAllowAnyOrigin) {
        console.log(`[DS-API] CORS: reflecting any Origin (HOST=${HOST} is loopback and DS_ALLOWED_ORIGINS is empty).`);
    } else if (configModule.get().allowedOrigins.length > 0) {
        console.log(`[DS-API] CORS: allowlist of ${configModule.get().allowedOrigins.length} origin(s): ${configModule.get().allowedOrigins.join(', ')}`);
    } else {
        console.warn(`[DS-API] WARNING: HOST=${HOST} is not loopback and DS_ALLOWED_ORIGINS is empty; CORS will deny all browser origins (anti-CSRF). Set DS_ALLOWED_ORIGINS to allow specific origins.`);
    }

    setInterval(() => {
        try { sweepIdleSessions(); }
        catch (e) { debugLog(console.error, '[DS-API] sweepIdleSessions failed:', e.message); }
    }, configModule.get().sessionSweepIntervalMs).unref();

    runtime.listen(() => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT}`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/responses (OpenAI Responses API, stream=true|false)');
    });

    return runtime;
}

if (require.main === module) {
    let runtime;

    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));

    process.on('uncaughtException', (err) => {
        console.error('[DS-API] uncaughtException:', err);
        process.exitCode = 1;

        if (runtime && runtime.shutdownCtl && !runtime.shutdownCtl.shuttingDown) {
            setTimeout(() => process.exit(1), 5000).unref();
            runtime.shutdownCtl.shutdown('uncaughtException', 1);
            return;
        }
        setImmediate(() => process.exit(1));
    });

    try {
        runtime = main();
    } catch (err) {
        console.error('[DS-API] FATAL:', err);
        process.exit(1);
    }

    process.on('SIGTERM', () => runtime.shutdownCtl.shutdown('SIGTERM'));
    process.on('SIGINT', () => runtime.shutdownCtl.shutdown('SIGINT'));
}

module.exports = { buildRuntime, main, deleteOrphanedRemoteSessions };
