'use strict';

function createSemaphore(max) {
    const limit = Math.max(1, Number(max) || 1);
    let inFlight = 0;
    
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
        tryAcquire: acquire,
        waitForZero,
    };
}

module.exports = { createSemaphore };
