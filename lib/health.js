'use strict';
// Liveness / readiness report for a locally-run proxy, exposed as GET /health
// by index.js. All inputs are injected (accounts, session count, semaphore,
// shutdown flag) so the report shape can be unit-tested without loading auth
// config or opening sockets.
//
// The endpoint answers 200 while the server is healthy and 503 while it is
// draining, so a supervisor (or scripts/start.sh check) can treat a 503 as
// "not ready" and stop sending work during graceful shutdown.

const accountsModule = require('./accounts');
const sessionsModule = require('./sessions');
const { isLoopbackAddress } = require('./http');

// Build the health report from the current in-memory state. Every input has a
// production default, so `buildHealthReport()` works as-is; tests pass stubs.
//
// `detailed` controls how much is disclosed: a non-loopback caller gets only
// the minimal readiness signal (`status` + `shutting_down`), while a loopback
// caller (the normal case) also gets uptime, the upstream host, account
// counts, the session count and the concurrency block. This keeps the endpoint
// useful to a local supervisor without turning it into reconnaissance on a
// network-exposed bind.
function buildHealthReport({
    accounts = accountsModule.getAccounts(),
    sessionCount = sessionsModule.getSessionCount(),
    remoteHost = accountsModule.getRemoteHost(),
    semaphore = null,
    shuttingDown = false,
    startedAt = 0,
    now = Date.now(),
    detailed = true,
} = {}) {
    const report = {
        status: shuttingDown ? 'shutting_down' : 'ok',
        shutting_down: shuttingDown,
    };
    if (!detailed) return report;

    // An account is "usable" only when it has both credentials; among those,
    // "available" additionally means not cooling down. This mirrors the checks
    // in accounts.hasAvailableAccount()/selectAccountForSession().
    const list = accounts || [];
    const usable = list.filter(a => a && a.config && a.config.token && a.config.cookie);
    const available = usable.filter(a => a.cooldownUntil <= now).length;

    report.uptime_ms = startedAt ? Math.max(0, now - startedAt) : 0;
    report.remote_host = remoteHost || null;
    report.accounts = {
        total: list.length,
        usable: usable.length,
        available,
        cooling: usable.length - available,
    };
    report.sessions = sessionCount;
    if (semaphore) {
        report.concurrency = {
            in_flight: semaphore.inFlight,
            limit: semaphore.limit,
            available: semaphore.available,
        };
    }
    return report;
}

// Write the report as JSON. 503 while draining so a poller treats the server
// as not-ready; 200 otherwise.
//
// The detail level is derived from the peer address: a loopback caller gets
// the full report, anything else gets only the minimal readiness signal (see
// buildHealthReport). An explicit `detailed` in `deps` overrides the lookup.
function handleHealth(req, res, deps = {}) {
    const peerAddress = deps.peerAddress !== undefined
        ? deps.peerAddress
        : (req && req.socket ? req.socket.remoteAddress : '');
    // No peer info at all (e.g. unit tests passing req=null) stays detailed;
    // only a positively non-loopback peer is downgraded.
    const detailed = deps.detailed !== undefined
        ? deps.detailed
        : (peerAddress ? isLoopbackAddress(peerAddress) : true);
    const report = buildHealthReport({ ...deps, detailed });
    const body = JSON.stringify(report);
    res.writeHead(report.shutting_down ? 503 : 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

module.exports = { buildHealthReport, handleHealth };
