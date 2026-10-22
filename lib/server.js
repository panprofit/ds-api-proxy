'use strict';

const http = require('http');
const health = require('./health');
const handlers = require('./handlers');
const config = require('./config');
const { createShutdown } = require('./shutdown');
const metrics = require('./metrics');

const AVAILABLE_MODELS = ['deepseek', 'deepseek-chat', 'deepseek-reasoner'];

function modelsPayload() {
    return {
        object: 'list',
        data: AVAILABLE_MODELS.map(id => ({ id, object: 'model', created: 0, owned_by: 'deepseek' })),
    };
}

/**
 * @param {{
 *   semaphore?: any,
 *   requestDeps?: any,
 *   resetAllRemoteSessions?: () => number,
 *   pendingDeletesSize?: () => number,
 *   startedAt?: number,
 *   port?: number,
 *   host?: string,
 *   log?: (...args: any[]) => void,
 *   error?: (...args: any[]) => void,
 *   exit?: (code: number) => void,
 * }} options
 */
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
    exit = /** @type {(code: number) => void} */ ((code) => process.exit(code)),
} = {}) {
    
    let listening = false;
    
    let shutdownCtl = null;

    const server = http.createServer(async (req, res) => {
        handlers.applyCors(req, res);
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        
        let url;
        try {
            url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Malformed request URL.', type: 'invalid_request_error' } }));
            return;
        }
        
        if (url.pathname === '/health') {
            if (req.method !== 'GET') { res.writeHead(405, { 'Allow': 'GET' }); res.end('Method not allowed'); return; }
            health.handleHealth(req, res, { semaphore, shuttingDown: shuttingDown(), startedAt, metrics: metrics.snapshot() });
            return;
        }
        
        if (url.pathname === '/v1/models') {
            if (req.method !== 'GET') { res.writeHead(405, { 'Allow': 'GET' }); res.end('Method not allowed'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(modelsPayload()));
            return;
        }

        if (req.method !== 'POST' || !handlers.ACCEPTED_POST_PATHS.includes(url.pathname)) {
            res.writeHead(404); res.end('Not found'); return;
        }
        
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
        
        req.on('error', releaseSlot);
        res.on('close', releaseSlot);

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
                
                res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
                res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'payload_too_large' } }));
                return;
            }
            metrics.inc('requests');
            if (url.pathname === '/v1/responses') {
                await handlers.handleResponses(req, res, body, requestDeps);
            } else {
                await handlers.handleChatCompletions(req, res, body, requestDeps);
            }
        } finally {
            releaseSlot();
        }
    });
    
    server.headersTimeout = config.get().headersTimeoutMs;
    server.requestTimeout = config.get().requestTimeoutMs;
    
    server.on('error', (err) => {
        if (!listening) {
            if (/** @type {any} */ (err).code === 'EADDRINUSE') error(`[DS-API] FATAL: port ${port} already in use. Set PORT=<other> or stop the other instance.`);
            else error('[DS-API] FATAL: server startup error:', err);
            exit(1);
            return;
        }
        error('[DS-API] server error (continuing):', err);
    });
    
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
