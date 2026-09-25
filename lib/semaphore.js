'use strict';
// Minimal counting semaphore for the concurrency limit. Compared to a bare
// `inFlight++` counter it guarantees a slot is released exactly once: the
// release function is idempotent, so double-release (e.g. both `aborted` and
// `error` firing, plus the `finally` block) cannot corrupt the count.
//
// It also exposes an event-driven `waitForZero(timeoutMs)` so graceful shutdown
// can await a full drain without polling the counter.
//
// Usage:
//   const sem = createSemaphore(24);
//   const release = sem.tryAcquire();   // null when full
//   if (!release) return busy();
//   try { ... } finally { release(); }
//
//   const drained = await sem.waitForZero(15000); // true if it reached 0

function createSemaphore(max) {
    const limit = Math.max(1, Number(max) || 1);
    let inFlight = 0;
    // Pending waitForZero() callers, each { resolve, timer }. Notified (and
    // cleared) whenever inFlight drops to 0.
    const zeroWaiters = new Set();

    function notifyIfZero() {
        if (inFlight !== 0 || zeroWaiters.size === 0) return;
        for (const waiter of zeroWaiters) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(true);
        }
        zeroWaiters.clear();
    }

    function acquire() {
        if (inFlight >= limit) return null;
        inFlight++;
        let released = false;
        return function release() {
            if (released) return false;
            released = true;
            inFlight--;
            notifyIfZero();
            return true;
        };
    }

    // Resolve `true` as soon as inFlight reaches 0, or `false` if `timeoutMs`
    // elapses first. Event-driven: no polling. `timeoutMs <= 0` waits forever.
    function waitForZero(timeoutMs = 0) {
        if (inFlight === 0) return Promise.resolve(true);
        return new Promise((resolve) => {
            const waiter = { resolve, timer: null };
            if (timeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    zeroWaiters.delete(waiter);
                    resolve(false);
                }, timeoutMs);
            }
            zeroWaiters.add(waiter);
        });
    }

    return {
        get limit() { return limit; },
        get inFlight() { return inFlight; },
        get available() { return limit - inFlight; },
        isFull() { return inFlight >= limit; },
        acquire,
        // Alias kept for callers that read `tryAcquire` more naturally.
        tryAcquire: acquire,
        waitForZero,
    };
}

module.exports = { createSemaphore };
