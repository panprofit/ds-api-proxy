#!/usr/bin/env node
// Process launcher for the DeepSeek proxy. The HTTP server itself (router,
// socket hardening, shutdown controller) is built by lib/server.js; this file
// owns the process-level concerns: the required-env guard, the startup auth
// audit, the idle-session sweep, signal handling and the uncaught-exception
// policy. Keeping those here and the server there means the router/lifecycle
// wiring can be tested without spawning a process.
const {
    getOrCreateAgentSession, prepareSessionForPrompt,
    resetRemoteSession, sweepIdleSessions, setRemoteSessionDeleter,
    resetAllRemoteSessions,
} = require('./lib/sessions');
const {
    selectAccountForSession, markAccountFailure,
    loadDSConfig, auditAuthDir, setRemoteHost, getAccountById,
} = require('./lib/accounts');
const {
    dsChatCompletionWithPow, solvePowForPath,
    createRemoteSession, deleteRemoteSession,
} = require('./lib/upstream');
const { readDSResponse } = require('./lib/sse');
const { createUpstreamHttpError } = require('./lib/http');
const { createUpstreamSession } = require('./lib/upstream-session');
const { createSemaphore } = require('./lib/semaphore');
const { createServer } = require('./lib/server');
const configModule = require('./lib/config');
const { debugLog } = require('./lib/debug');

const config = configModule.get();
const PORT = config.port;
const HOST = config.host;
const REMOTE_HOST = config.remoteHost;

// The required-env guard runs at load time so a missing DS_REMOTE_HOST is a
// hard, immediate failure rather than a 503 on the first request.
const missingEnv = [];
if (!REMOTE_HOST) missingEnv.push('DS_REMOTE_HOST (e.g. chat.deepseek.com)');
if (missingEnv.length > 0) {
    console.error(`[DS-API] FATAL: missing required env: ${missingEnv.join(', ')}`);
    process.exit(1);
}
setRemoteHost(REMOTE_HOST);

// In-flight best-effort deletes. Tracked so graceful shutdown can wait for the
// last remote-session deletion to settle before exiting.
const pendingDeletes = new Set();
function trackDelete(promise) {
    pendingDeletes.add(promise);
    // Clean up regardless of outcome; never let a rejection escape unhandled.
    promise.catch(() => {}).finally(() => pendingDeletes.delete(promise));
}

// Delete a remote session for the given account, best-effort. Resolves even on
// failure (errors are logged) so callers can await it unconditionally.
function deleteRemoteSessionForAccount(accountId, sessionId) {
    const account = accountId ? getAccountById(accountId) : null;
    if (!account) {
        debugLog(console.log, `[DS-API] no account ${accountId} for remote session ${sessionId}; skipping delete`);
        return Promise.resolve();
    }
    return Promise.resolve(deleteRemoteSession(account, account.headers, sessionId))
        .catch(e => debugLog(console.error, '[DS-API] remote session delete failed:', e.message));
}

// Every local session reset must first delete its upstream session, otherwise
// the remote session leaks. Fire-and-forget: sessions.resetRemoteSession()
// never awaits it; the promise is tracked for shutdown.
setRemoteSessionDeleter((accountId, sessionId) => {
    trackDelete(deleteRemoteSessionForAccount(accountId, sessionId));
});

// Build the runtime (upstream session wrapper, semaphore, server). Kept in a
// function so requiring this module never opens a listener or reads accounts.
function buildRuntime({ startedAt = Date.now() } = {}) {
    const askDSStream = createUpstreamSession({
        getOrCreateAgentSession,
        prepareSessionForPrompt,
        resetRemoteSession,
        selectAccountForSession,
        markAccountFailure,
        solvePowForPath,
        createRemoteSession,
        dsChatCompletionWithPow,
        createUpstreamHttpError,
    });

    // In-flight concurrency limiter. The release function is idempotent, so the
    // `aborted` / `error` listeners and the `finally` block cannot double-release.
    const semaphore = createSemaphore(config.maxConcurrent);

    const requestDeps = {
        askDSStream, readDSResponse,
        maxEmptyRetries: config.maxEmptyRetries,
        malformedCooldownMs: config.malformedToolCallCooldownMs,
        requestDeadlineMs: config.requestDeadlineMs,
    };

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

// Startup auth-directory audit: report the DS_AUTH_DIR setup once at boot so a
// misconfiguration is obvious immediately instead of surfacing as a 503 on the
// first request. Advisory only — the server still starts with zero accounts.
function auditAuthDirAtStartup() {
    loadDSConfig({ fatal: false });
    const authAudit = auditAuthDir();
    if (authAudit.level === 'ok') console.log(`[DS-API] ${authAudit.message}`);
    else if (authAudit.level === 'warn') console.warn(`[DS-API] WARNING: ${authAudit.message}`);
    else console.error(`[DS-API] ERROR: ${authAudit.message}`);
}

function main() {
    auditAuthDirAtStartup();
    const runtime = buildRuntime({ startedAt: Date.now() });

    if (!configModule.get().hostIsLoopback && configModule.get().allowedOrigins.length === 0) {
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
    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));
    // After an uncaught exception the process state is undefined (dangling
    // sockets, possibly corrupted shared state), so log and exit instead of
    // pretending to keep serving. Only the server 'error' listener is safe to
    // continue from.
    process.on('uncaughtException', (err) => {
        console.error('[DS-API] uncaughtException (exiting):', err);
        // Do not call process.exit() synchronously here: stderr may be a pipe
        // or file (see scripts/start.sh) and the write is buffered, so an
        // immediate exit can drop the diagnostic. Mark the exit code and let
        // the streams flush on the next turn of the event loop.
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
    });

    let runtime;
    try {
        runtime = main();
    } catch (err) {
        console.error('[DS-API] FATAL:', err);
        process.exit(1);
    }

    process.on('SIGTERM', () => runtime.shutdownCtl.shutdown('SIGTERM'));
    process.on('SIGINT', () => runtime.shutdownCtl.shutdown('SIGINT'));
}

module.exports = { buildRuntime, main };
