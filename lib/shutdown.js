'use strict';

function waitForDrain(size, timeoutMs, pollMs = 100) {
    if (size() === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (size() === 0) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            
            setTimeout(tick, pollMs);
        };
        tick();
    });
}

function createShutdown({
    server,
    semaphore,
    pendingDeletesSize,
    resetAllRemoteSessions,
    graceMs,
    log = console.log,
    error = console.error,
    exit = /** @type {(code: number) => void} */ ((code) => process.exit(code)),
}) {
    let shuttingDown = false;

    async function shutdown(sig) {
        if (shuttingDown) return false;
        shuttingDown = true;
        log(`[DS-API] ${sig} received — draining (grace ${graceMs}ms)…`);
        
        server.close();
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

        const drained = await semaphore.waitForZero(graceMs);
        if (!drained) {
            error(`[DS-API] grace period expired with ${semaphore.inFlight} request(s) in flight — forcing close.`);
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }
        
        const deleteAttempts = resetAllRemoteSessions();
        if (deleteAttempts > 0) {
            log(`[DS-API] deleting ${deleteAttempts} remote session(s) before exit…`);
            await waitForDrain(pendingDeletesSize, graceMs);
        }

        log(`[DS-API] shutdown complete (drained=${drained}, remote_deletes_attempted=${deleteAttempts}).`);
        exit(0);
        return true;
    }

    return {
        shutdown,
        get shuttingDown() { return shuttingDown; },
    };
}

module.exports = { createShutdown, waitForDrain };
