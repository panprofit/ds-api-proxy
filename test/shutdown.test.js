'use strict';
// Unit tests for lib/shutdown.js. All side effects (server, semaphore, exit,
// logs) are faked, so the shutdown path is exercised without a process, a
// real socket, or real signals.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createShutdown, waitForDrain } = require('../lib/shutdown');

// A fake semaphore whose drain resolution the test controls.
function fakeSemaphore({ inFlight = 0 } = {}) {
    return {
        inFlight,
        // resolves after `delayMs`; if `forever` is true, never resolves.
        waitForZeroCalls: [],
        waitForZero(timeoutMs) {
            this.waitForZeroCalls.push(timeoutMs);
            if (this._forever) return new Promise(() => {});
            const { resolveAfter, result } = this._plan || {};
            if (resolveAfter == null) return Promise.resolve(result ?? true);
            return new Promise((resolve) => setTimeout(() => resolve(result ?? true), resolveAfter));
        },
    };
}

function fakeServer() {
    return {
        closed: 0,
        idleClosed: 0,
        allClosed: 0,
        close() { this.closed++; },
        closeIdleConnections() { this.idleClosed++; },
        closeAllConnections() { this.allClosed++; },
    };
}

function collectLogs() {
    const logs = [];
    const errors = [];
    return {
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        logs,
        errors,
    };
}

function makeCtl(overrides = {}) {
    const server = overrides.server || fakeServer();
    const semaphore = overrides.semaphore || fakeSemaphore();
    const sink = collectLogs();
    let exitCode = null;
    let pendingSize = overrides.pendingSize ?? 0;
    let resets = overrides.resets ?? 0;
    const ctl = createShutdown({
        server,
        semaphore,
        pendingDeletesSize: () => pendingSize,
        resetAllRemoteSessions: () => resets,
        graceMs: overrides.graceMs ?? 1000,
        log: sink.log,
        error: sink.error,
        exit: (code) => { exitCode = code; },
        ...overrides.extra,
    });
    return {
        ctl, server, semaphore, sink,
        get exitCode() { return exitCode; },
        setPendingSize: (n) => { pendingSize = n; },
        setResets: (n) => { resets = n; },
    };
}

test('shutdown: closes the server, drains, and exits 0 when drained', async () => {
    const h = makeCtl();
    const ok = await h.ctl.shutdown('SIGTERM');
    assert.equal(ok, true);
    assert.equal(h.server.closed, 1);
    assert.equal(h.server.idleClosed, 1);
    assert.equal(h.server.allClosed, 0, 'no force-close when drained');
    assert.deepEqual(h.semaphore.waitForZeroCalls, [1000]);
    assert.equal(h.exitCode, 0);
    assert.ok(h.sink.logs.some((l) => /SIGTERM received/.test(l)));
    assert.ok(h.sink.logs.some((l) => /shutdown complete \(drained=true/.test(l)));
});

test('shutdown: force-closes and logs when the grace period expires', async () => {
    const semaphore = fakeSemaphore({ inFlight: 3 });
    semaphore._plan = { resolveAfter: 5, result: false };
    const h = makeCtl({ semaphore });
    await h.ctl.shutdown('SIGTERM');
    assert.equal(h.server.allClosed, 1, 'closeAllConnections on timeout');
    assert.ok(h.sink.errors.some((e) => /grace period expired with 3 request/.test(e)));
    assert.ok(h.sink.logs.some((l) => /drained=false/.test(l)));
});

test('shutdown: deletes remote sessions and waits for pending deletes to settle', async () => {
    const h = makeCtl({ resets: 2 });
    // Start with 1 pending delete, then clear it so waitForDrain can resolve.
    h.setPendingSize(1);
    setTimeout(() => h.setPendingSize(0), 10);
    await h.ctl.shutdown('SIGINT');
    assert.ok(h.sink.logs.some((l) => /deleting 2 remote session\(s\)/.test(l)));
    assert.equal(h.exitCode, 0);
});

test('shutdown: skips the delete-drain when there is nothing to delete', async () => {
    const h = makeCtl({ resets: 0 });
    await h.ctl.shutdown('SIGTERM');
    assert.ok(!h.sink.logs.some((l) => /deleting/.test(l)));
    assert.equal(h.exitCode, 0);
});

test('shutdown: is idempotent — a second call is a no-op', async () => {
    const h = makeCtl();
    assert.equal(await h.ctl.shutdown('SIGTERM'), true);
    assert.equal(await h.ctl.shutdown('SIGINT'), false);
    assert.equal(h.server.closed, 1, 'server.close called only once');
    // Only the first shutdown logged a start line.
    assert.equal(h.sink.logs.filter((l) => /received/.test(l)).length, 1);
});

test('shutdown: shuttingDown flips true before the drain completes', async () => {
    const semaphore = fakeSemaphore();
    semaphore._plan = { resolveAfter: 5 };
    const h = makeCtl({ semaphore });
    assert.equal(h.ctl.shuttingDown, false);
    const p = h.ctl.shutdown('SIGTERM');
    assert.equal(h.ctl.shuttingDown, true);
    await p;
});

test('shutdown: works when the server has no closeIdleConnections/closeAllConnections', async () => {
    const server = { closed: 0, close() { this.closed++; } };
    const h = makeCtl({ server });
    await h.ctl.shutdown('SIGTERM');
    assert.equal(server.closed, 1);
    assert.equal(h.exitCode, 0);
});

// --- waitForDrain -----------------------------------------------------------

test('waitForDrain: resolves true immediately when already empty', async () => {
    assert.equal(await waitForDrain(() => 0, 1000), true);
});

test('waitForDrain: resolves true once size reaches 0', async () => {
    let n = 1;
    setTimeout(() => { n = 0; }, 10);
    assert.equal(await waitForDrain(() => n, 1000, 5), true);
});

test('waitForDrain: resolves false on timeout', async () => {
    assert.equal(await waitForDrain(() => 1, 20, 5), false);
});
