'use strict';
// Unit tests for lib/semaphore.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSemaphore } = require('../lib/semaphore');

test('semaphore: acquire increments inFlight up to the limit', () => {
    const sem = createSemaphore(2);
    assert.equal(sem.inFlight, 0);
    const r1 = sem.acquire();
    const r2 = sem.acquire();
    assert.ok(r1 && r2);
    assert.equal(sem.inFlight, 2);
    assert.equal(sem.isFull(), true);
    assert.equal(sem.acquire(), null);
});

test('semaphore: release frees a slot for the next acquire', () => {
    const sem = createSemaphore(1);
    const r1 = sem.acquire();
    assert.equal(sem.acquire(), null);
    r1();
    assert.equal(sem.inFlight, 0);
    const r2 = sem.acquire();
    assert.ok(r2);
    assert.equal(sem.inFlight, 1);
});

test('semaphore: release is idempotent (no double-decrement)', () => {
    const sem = createSemaphore(2);
    const release = sem.acquire();
    assert.equal(release(), true);
    assert.equal(release(), false);
    assert.equal(release(), false);
    assert.equal(sem.inFlight, 0);
});

test('semaphore: available reflects remaining slots', () => {
    const sem = createSemaphore(3);
    const r1 = sem.acquire();
    const r2 = sem.acquire();
    assert.equal(sem.available, 1);
    r1();
    assert.equal(sem.available, 2);
    r2();
    assert.equal(sem.available, 3);
});

test('semaphore: invalid limit falls back to 1', () => {
    assert.equal(createSemaphore(0).limit, 1);
    assert.equal(createSemaphore(-5).limit, 1);
    assert.equal(createSemaphore(undefined).limit, 1);
    assert.equal(createSemaphore('abc').limit, 1);
});

test('semaphore: tryAcquire is an alias of acquire', () => {
    const sem = createSemaphore(1);
    const r = sem.tryAcquire();
    assert.equal(sem.inFlight, 1);
    r();
    assert.equal(sem.inFlight, 0);
});

test('semaphore: waitForZero resolves immediately when idle', async () => {
    const sem = createSemaphore(2);
    assert.equal(await sem.waitForZero(50), true);
});

test('semaphore: waitForZero resolves when the last slot is released', async () => {
    const sem = createSemaphore(2);
    const r1 = sem.acquire();
    const r2 = sem.acquire();
    let resolved = false;
    const pending = sem.waitForZero(1000).then((v) => { resolved = true; return v; });
    // Still busy: not resolved yet.
    await Promise.resolve();
    assert.equal(resolved, false);
    r1();
    await Promise.resolve();
    assert.equal(resolved, false, 'still one slot in flight');
    r2();
    assert.equal(await pending, true);
});

test('semaphore: waitForZero resolves true even if it was already freed', async () => {
    const sem = createSemaphore(1);
    const r = sem.acquire();
    const pending = sem.waitForZero(1000);
    r();
    assert.equal(await pending, true);
});

test('semaphore: waitForZero resolves false on timeout', async () => {
    const sem = createSemaphore(1);
    const r = sem.acquire();
    assert.equal(await sem.waitForZero(20), false);
    r();
});

test('semaphore: waitForZero notifies multiple waiters', async () => {
    const sem = createSemaphore(1);
    const r = sem.acquire();
    const a = sem.waitForZero(1000);
    const b = sem.waitForZero(1000);
    r();
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test('semaphore: a timed-out waiter is not notified later', async () => {
    const sem = createSemaphore(1);
    const r = sem.acquire();
    assert.equal(await sem.waitForZero(10), false);
    r(); // must not throw / double-resolve
    assert.equal(sem.inFlight, 0);
});
