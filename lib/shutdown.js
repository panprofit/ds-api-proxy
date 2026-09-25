'use strict';
// Graceful shutdown: stop accepting connections, drain in-flight requests and
// pending remote-session deletes within a bounded grace period, then exit.
//
// The shutdown path — one of the hardest
// parts to exercise — can be unit-tested without spawning a process or raising
// real signals. All side effects are injected: the HTTP server, the request
// semaphore, the pending-delete counter, the remote-session resetter, and the
// log/error/exit sinks.

// Wait until `size()` returns 0, or `timeoutMs` elapses. Used for the pending
// remote-session deletes (a Set). The in-flight request counter is drained via
// the semaphore's event-driven `waitForZero()` instead of this polling helper.
function waitForDrain(size, timeoutMs, pollMs = 100) {
    if (size() === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (size() === 0) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            // Do NOT unref this timer: during shutdown we are deliberately
            // waiting, and an unref'd timer lets the event loop exit before the
            // timeout fires (the promise would then never settle).
            setTimeout(tick, pollMs);
        };
        tick();
    });
}

// Create a guarded shutdown function. Calling it more than once is a no-op
// (returns false for the repeat) so repeated SIGTERM/SIGINT during a drain do
// not start a second drain.
function createShutdown({
    server,
    semaphore,
    pendingDeletesSize,
    resetAllRemoteSessions,
    graceMs,
    log = console.log,
    error = console.error,
    exit = (code) => process.exit(code),
}) {
    let shuttingDown = false;

    async function shutdown(sig) {
        if (shuttingDown) return false;
        shuttingDown = true;
        log(`[DS-API] ${sig} received — draining (grace ${graceMs}ms)…`);

        // Stop accepting new connections, then close idle keep-alive sockets so
        // they do not hold the server open while in-flight work finishes.
        server.close();
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

        const drained = await semaphore.waitForZero(graceMs);
        if (!drained) {
            error(`[DS-API] grace period expired with ${semaphore.inFlight} request(s) in flight — forcing close.`);
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }

        // Delete every remote session left on any account so nothing is
        // orphaned upstream. The count is the number of deletions *attempted*
        // (fire-and-forget), not the number confirmed deleted. A crash cannot
        // run this, so remote sessions are also swept on the next startup.
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
