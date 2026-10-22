'use strict';

const accountsModule = require('./accounts');
const sessionsModule = require('./sessions');
const { isLoopbackAddress } = require('./http');

function buildHealthReport({
    accounts = accountsModule.getAccounts(),
    sessionCount = sessionsModule.getSessionCount(),
    semaphore = null,
    metrics = null,
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
    
    const list = accounts || [];
    const usable = list.filter(a => a && a.config && a.config.token && a.config.cookie);
    const expired = usable.filter(a => a.authExpired).length;
    const available = usable.filter(a => !a.authExpired && a.cooldownUntil <= now).length;

    report.uptime_ms = startedAt ? Math.max(0, now - startedAt) : 0;
    report.accounts = {
        total: list.length,
        usable: usable.length,
        available,
        cooling: usable.length - available - expired,
        expired,
    };
    report.sessions = sessionCount;
    
    if (metrics) report.metrics = metrics;
    if (semaphore) {
        report.concurrency = {
            in_flight: semaphore.inFlight,
            limit: semaphore.limit,
            available: semaphore.available,
        };
    }
    return report;
}

function handleHealth(req, res, deps = {}) {
    const peerAddress = deps.peerAddress !== undefined
        ? deps.peerAddress
        : (req && req.socket ? req.socket.remoteAddress : '');
    
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
