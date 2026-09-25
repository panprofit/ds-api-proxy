'use strict';
// HTTP server construction: the router, socket hardening, the fatal-before-
// listen error policy and the graceful-shutdown controller.
//
// Extracted from index.js so the whole request/dispatch/lifecycle wiring can
// be built from injected dependencies and exercised without loading auth
// config or spawning a process. index.js keeps the process-level concerns
// (env guards, signal handlers, the idle-session sweep, listening); this module
// owns the server object itself.
//
// Unlike the previous inline wiring, `shutdownCtl` is a `let` initialised to
// null before the request handler is created. The handler reads it defensively
// (`shutdownCtl && shutdownCtl.shuttingDown`), so there is no temporal-dead-
// zone dependency on a later `const` — a request that somehow arrived before
// the controller was assigned would see "not shutting down" instead of
// throwing a ReferenceError.

const http = require('http');
const health = require('./health');
const handlers = require('./handlers');
const config = require('./config');
const { createShutdown } = require('./shutdown');

// Build the proxy HTTP server. All collaborators are injected: the concurrency
// `semaphore`, the per-request `requestDeps` (askDSStream/readDSResponse/…),
// the shutdown hooks (`resetAllRemoteSessions`, `pendingDeletesSize`) and the
// log/error/exit sinks. Returns the server plus its shutdown controller and a
// `listen()` that flips the internal `listening` flag.
function createServer({
    semaphore,
    requestDeps,
    resetAllRemoteSessions = () => 0,
    pendingDeletesSize = () => 0,
    startedAt = Date.now(),
    port = config.get().port,
    host = config.get().host,
    log = console.log,
    error = console.error,
    exit = (code) => process.exit(code),
} = {}) {
    // Set true once the listener is accepting connections. Before that, any
    // server error (e.g. EADDRINUSE) is fatal; after that, runtime errors are
    // logged and the process keeps serving (#14).
    let listening = false;

    // Assigned below, after `server` exists. Declared with `let` (not `const`)
    // so the request handler can read it before assignment without a TDZ trap.
    let shutdownCtl = null;

    const server = http.createServer(async (req, res) => {
        handlers.applyCors(req, res);
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // Liveness / readiness. Answered for GET only (the proxy is otherwise
        // POST-only); returns 503 while draining so a supervisor stops routing
        // work during graceful shutdown. CORS headers are already applied above.
        if (url.pathname === '/health') {
            if (req.method !== 'GET') { res.writeHead(405, { 'Allow': 'GET' }); res.end('Method not allowed'); return; }
            health.handleHealth(req, res, { semaphore, shuttingDown: shuttingDown(), startedAt });
            return;
        }

        if (req.method !== 'POST' || !handlers.ACCEPTED_POST_PATHS.includes(url.pathname)) {
            res.writeHead(404); res.end('Not found'); return;
        }

        // While draining, reject new work immediately so in-flight requests can
        // finish and the process can exit without waiting for the hard timeout.
        if (shuttingDown()) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Connection': 'close', 'Retry-After': '5' });
            res.end(JSON.stringify({ error: { message: 'Server is shutting down.', type: 'shutting_down' } }));
            return;
        }

        const releaseSlot = semaphore.acquire();
        if (!releaseSlot) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
            res.end(JSON.stringify({ error: { message: `Server busy (${semaphore.inFlight}/${semaphore.limit} requests in flight). Retry shortly.`, type: 'overloaded' } }));
            return;
        }
        req.on('aborted', releaseSlot);
        req.on('error', releaseSlot);

        try {
            const { body, tooLarge, timedOut, errored } = await handlers.readRequestBody(req, config.get().maxBodyBytes);
            if (timedOut) {
                res.writeHead(408, { 'Content-Type': 'application/json', 'Connection': 'close' });
                res.end(JSON.stringify({ error: { message: 'Request body read timed out.', type: 'request_timeout' } }));
                return;
            }
            if (errored) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Failed to read request body.', type: 'invalid_request_error' } }));
                return;
            }
            if (tooLarge) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'payload_too_large' } }));
                return;
            }
            if (url.pathname === '/v1/responses') {
                await handlers.handleResponses(req, res, body, requestDeps);
            } else {
                await handlers.handleChatCompletions(req, res, body, requestDeps);
            }
        } finally {
            releaseSlot();
        }
    });

    // Socket-level hardening.
    server.headersTimeout = config.get().headersTimeoutMs;
    server.requestTimeout = config.get().requestTimeoutMs;

    // Only startup errors are fatal (#14). Once the server is listening, runtime
    // errors (EMFILE, ECONNRESET during accept, …) are logged but must not take
    // the process down — the listener keeps serving existing/new connections.
    server.on('error', (err) => {
        if (!listening) {
            if (err.code === 'EADDRINUSE') error(`[DS-API] FATAL: port ${port} already in use. Set PORT=<other> or stop the other instance.`);
            else error('[DS-API] FATAL: server startup error:', err);
            exit(1);
            return;
        }
        error('[DS-API] server error (continuing):', err);
    });

    // Graceful shutdown controller (see lib/shutdown.js). Created after
    // `server` so it can close it. The handler above reads it through the
    // `shuttingDown()` helper, which tolerates the null window.
    shutdownCtl = createShutdown({
        server,
        semaphore,
        pendingDeletesSize,
        resetAllRemoteSessions,
        graceMs: config.get().shutdownGraceMs,
        log,
        error,
        exit,
    });

    function shuttingDown() {
        return Boolean(shutdownCtl && shutdownCtl.shuttingDown);
    }

    // Bind the listener and flip `listening` only once it is actually up, so
    // an EADDRINUSE during listen is still treated as fatal.
    function listen(cb) {
        server.listen(port, host, () => {
            listening = true;
            if (typeof cb === 'function') cb();
        });
    }

    return {
        server,
        shutdownCtl,
        listen,
        shuttingDown,
        get listening() { return listening; },
    };
}

module.exports = { createServer };
