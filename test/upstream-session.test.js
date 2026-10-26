'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createUpstreamSession } = require('../lib/upstream-session');
const config = require('../lib/config');
const { estimateTokens } = require('../lib/openai');

afterEach(() => config.reload());

function makeAccount(id = 'a1') {
    return { id, headers: { 'X-Test': '1' }, config: {} };
}

function makeSession(overrides = {}) {
    return {
        id: null, parentMessageId: null, createdAt: null,
        messageCount: 0, accountId: null, ...overrides,
    };
}

function makeDeps(overrides = {}) {
    const account = overrides.account || makeAccount();
    const session = overrides.session || makeSession();
    const calls = { completions: [], created: 0, pow: [] };
    const deps = {
        getOrCreateAgentSession: () => session,
        prepareSessionForPrompt: () => null,
        resetRemoteSession: (s) => { s.id = null; s.parentMessageId = null; s.accountId = null; },
        selectAccountForSession: () => account,
        markAccountFailure: () => {},
        solvePowForPath: async (a, h, path) => { calls.pow.push(path); return 'pow'; },
        createRemoteSession: async () => { calls.created++; return 'sess-' + calls.created; },
        dsChatCompletionWithPow: async (args) => {
            calls.completions.push(args);
            return { status: 200, ok: true, text: async () => '' };
        },
        createUpstreamHttpError: (status, _body) => {
            const e = new Error(`DS upstream HTTP ${status}`);
            e.status = status;
            return e;
        },
        log: () => {},
        ...overrides,
    };
    return { deps, calls, account, session };
}

test('askDSStream: creates a session then sends the completion', async () => {
    const { deps, calls, session } = makeDeps();
    const ask = createUpstreamSession(deps);
    const out = await ask({ prompt: 'hello', agentId: 'agent1' });
    assert.equal(out.promptUsed, 'hello');
    assert.equal(out.freshSessionReset, false);
    assert.equal(session.id, 'sess-1');
    assert.equal(calls.completions.length, 1);
    assert.equal(calls.completions[0].prompt, 'hello');
    assert.equal(calls.completions[0].powHeader, 'pow');
});

test('askDSStream: forwards the client abort signal to the completion', async () => {
    const { deps, calls } = makeDeps();
    const controller = new AbortController();
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hello', agentId: 'agent1', abortSignal: controller.signal });
    assert.equal(calls.completions[0].signal, controller.signal);
});

test('askDSStream: reuses an existing session without recreating', async () => {
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 'existing', accountId: 'a1' }),
    });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.equal(calls.created, 0);
    assert.equal(calls.completions[0].sessionId, 'existing');
});

test('askDSStream: recreates the session on HTTP 400 and retries once', async () => {
    const { deps, calls, session } = makeDeps({
        session: makeSession({ id: 'stale', accountId: 'a1' }),
    });
    let n = 0;
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        n++;
        if (n === 1) {
            return { status: 400, ok: false, headers: { get: () => null }, text: async () => 'expired' };
        }
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    const ask = createUpstreamSession(deps);
    const out = await ask({ prompt: 'hi', agentId: 'agent1', freshSessionPrompt: 'fresh-context' });

    assert.equal(calls.completions.length, 2);
    assert.equal(calls.completions[1].prompt, 'fresh-context');
    assert.equal(out.freshSessionReset, true);
    assert.equal(session.id, 'sess-1');
});

test('askDSStream: the retry after a session recreate takes a completion slot too', async () => {
    const slots = [];
    const { deps, session } = makeDeps({
        session: makeSession({ id: 'stale', accountId: 'a1' }),
        waitForCompletionSlot: async (account) => { slots.push(account.id); return true; },
    });
    let n = 0;
    deps.dsChatCompletionWithPow = async () => {
        n++;
        if (n === 1) return { status: 400, ok: false, headers: { get: () => null }, text: async () => 'expired' };
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1', freshSessionPrompt: 'fresh' });
    assert.deepEqual(slots, ['a1', 'a1'], 'both completions must reserve a throttle slot');
    assert.equal(session.id, 'sess-1');
});

test('askDSStream: throws a mapped error on non-recoverable statuses', async () => {
    const { deps } = makeDeps({
        session: makeSession({ id: 's1', accountId: 'a1' }),
    });
    deps.dsChatCompletionWithPow = async () => ({
        status: 401, ok: false, headers: { get: () => null }, text: async () => 'nope',
    });
    const ask = createUpstreamSession(deps);
    await assert.rejects(() => ask({ prompt: 'hi', agentId: 'agent1' }), /DS upstream HTTP 401/);
});

test('askDSStream: retries transient 5xx with backoff on the same account', async () => {
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 's1', accountId: 'a1' }),
        sleep: async () => {},
    });
    let n = 0;
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        n++;
        if (n < 3) {
            return { status: 503, ok: false, headers: { get: () => null }, text: async () => 'unavailable' };
        }
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    const ask = createUpstreamSession(deps);
    const out = await ask({ prompt: 'hi', agentId: 'agent1' });

    assert.equal(calls.completions.length, 3);
    assert.equal(calls.created, 0);
    assert.equal(out.resp.status, 200);
});

test('askDSStream: gives up on persistent 5xx after bounded retries', async () => {
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 's1', accountId: 'a1' }),
        sleep: async () => {},
    });
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        return { status: 502, ok: false, headers: { get: () => null }, text: async () => 'bad gateway' };
    };
    const ask = createUpstreamSession(deps);
    await assert.rejects(() => ask({ prompt: 'hi', agentId: 'agent1' }), /DS upstream HTTP 502/);

    assert.equal(calls.completions.length, 4);
});

test('askDSStream: a client disconnect stops transient 5xx retries', async () => {
    let gone = false;
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 's1', accountId: 'a1' }),
        sleep: async () => { gone = true; },
    });
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        return { status: 503, ok: false, headers: { get: () => null }, text: async () => 'unavailable' };
    };
    const ask = createUpstreamSession(deps);

    await assert.rejects(
        () => ask({ prompt: 'hi', agentId: 'agent1', clientGone: () => gone }),
        /DS upstream HTTP 503/
    );
    assert.equal(calls.completions.length, 1);
});

test('askDSStream: a client disconnect during transient retries does not mark the account', async () => {
    let gone = false;
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 's1', accountId: 'a1' }),
        sleep: async () => { gone = true; },
    });
    const failures = [];
    deps.markAccountFailure = (acct, status, label) => { failures.push({ status, label }); };
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        return { status: 503, ok: false, headers: { get: () => null }, text: async () => 'unavailable' };
    };
    const ask = createUpstreamSession(deps);

    await assert.rejects(
        () => ask({ prompt: 'hi', agentId: 'agent1', clientGone: () => gone }),
        /DS upstream HTTP 503/
    );
    assert.equal(calls.completions.length, 1);
    assert.deepEqual(failures, []);
});

test('askDSStream: recreates the session on 409/410 as well', async () => {
    for (const status of [409, 410]) {
        const { deps, calls, session } = makeDeps({
            session: makeSession({ id: 'stale', accountId: 'a1' }),
        });
        let n = 0;
        deps.dsChatCompletionWithPow = async (args) => {
            calls.completions.push(args);
            n++;
            if (n === 1) return { status, ok: false, headers: { get: () => null }, text: async () => 'gone' };
            return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
        };
        const ask = createUpstreamSession(deps);
        const out = await ask({ prompt: 'hi', agentId: 'agent1', freshSessionPrompt: 'fresh' });
        assert.equal(out.freshSessionReset, true, `status ${status} should reset the session`);
        assert.equal(session.id, 'sess-1');
    }
});

test('askDSStream: a failed retry after session recreate marks the account and throws', async () => {

    const { deps, calls, session } = makeDeps({
        session: makeSession({ id: 'stale', accountId: 'a1' }),
    });
    const failures = [];
    deps.markAccountFailure = (acct, status, label, retryAfter) => {
        failures.push({ status, label, retryAfter });
    };
    let n = 0;
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        n++;
        if (n === 1) {
            return { status: 400, ok: false, headers: { get: () => null }, text: async () => 'expired' };
        }
        return { status: 503, ok: false, headers: { get: () => '30' }, text: async () => 'still down' };
    };
    const ask = createUpstreamSession(deps);
    await assert.rejects(
        () => ask({ prompt: 'hi', agentId: 'agent1', freshSessionPrompt: 'fresh-context' }),
        /DS upstream HTTP 503/
    );

    assert.equal(calls.completions.length, 2);
    assert.equal(calls.completions[1].prompt, 'fresh-context');

    assert.deepEqual(failures, [
        { status: 400, label: 'completion', retryAfter: null },
        { status: 503, label: 'completion after session recreate', retryAfter: '30' },
    ]);
    assert.equal(session.id, 'sess-1');
});

test('askDSStream: uses the recovery prompt when session was reset by rotation', async () => {

    const session = makeSession({ id: 'old', accountId: 'a1' });
    const { deps, calls } = makeDeps({
        session,
        prepareSessionForPrompt: (s) => { s.id = null; return { reason: 'session_ttl', failedSessionId: 'old', failedMessageCount: 1, accountId: 'a1' }; },
    });
    const ask = createUpstreamSession(deps);
    const out = await ask({ prompt: 'incremental', agentId: 'agent1', freshSessionPrompt: 'full-context' });
    assert.equal(out.promptUsed, 'full-context');
    assert.equal(out.freshSessionReset, true);
    assert.equal(calls.completions[0].prompt, 'full-context');
});

test('askDSStream: forwards thinkingEnabled to the completion payload', async () => {
    const { deps, calls } = makeDeps();
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1', thinkingEnabled: true });
    assert.equal(calls.completions[0].thinkingEnabled, true);
});

test('askDSStream: thinkingEnabled defaults to undefined (disabled)', async () => {
    const { deps, calls } = makeDeps();
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.equal(calls.completions[0].thinkingEnabled, undefined);
});

test('askDSStream: forwards fileIds and thinkingEnabled together', async () => {
    const { deps, calls } = makeDeps();
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1', fileIds: ['f1'], thinkingEnabled: true });
    assert.deepEqual(calls.completions[0].fileIds, ['f1']);
    assert.equal(calls.completions[0].thinkingEnabled, true);
});

test('askDSStream: re-resolves fileIds when the selected account differs', async () => {
    const { deps, calls } = makeDeps();
    const seen = [];
    const ask = createUpstreamSession(deps);
    const out = await ask({
        prompt: 'hi', agentId: 'agent1',
        fileIds: ['old'],
        fileIdsAccountId: 'a0',
        resolveFileIds: async (account, opts) => {
            seen.push({ id: account.id, canAbort: typeof opts.shouldAbort === 'function' });
            return ['new'];
        },
    });
    assert.deepEqual(calls.completions[0].fileIds, ['new']);
    assert.deepEqual(out.fileIds, ['new']);
    assert.equal(out.fileIdsAccountId, 'a1');
    assert.deepEqual(seen, [{ id: 'a1', canAbort: true }]);
});

test('askDSStream: keeps fileIds when the account did not change', async () => {
    const { deps, calls } = makeDeps();
    let resolved = false;
    const ask = createUpstreamSession(deps);
    const out = await ask({
        prompt: 'hi', agentId: 'agent1',
        fileIds: ['f1'],
        fileIdsAccountId: 'a1',
        resolveFileIds: async () => { resolved = true; return ['other']; },
    });
    assert.equal(resolved, false);
    assert.deepEqual(calls.completions[0].fileIds, ['f1']);
    assert.deepEqual(out.fileIds, ['f1']);
    assert.equal(out.fileIdsAccountId, 'a1');
});

test('askDSStream: tags the session log line when thinking mode is enabled', async () => {

    const logs = [];
    const { deps } = makeDeps({ log: (m) => logs.push(m) });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1', thinkingEnabled: true });
    assert.ok(logs.some(m => /Created new session \(thinking\):/.test(m)), 'expected the created-session line to carry (thinking)');
    assert.ok(!logs.some(m => /Thinking enabled/.test(m)), 'the standalone thinking line was removed');
});

test('askDSStream: does not tag the session line when thinking is disabled', async () => {
    const logs = [];
    const { deps } = makeDeps({ log: (m) => logs.push(m) });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.ok(!logs.some(m => /\(thinking\)/.test(m)), 'did not expect a thinking tag');
});

test('askDSStream: context reflects the full conversation, not summed deltas', async () => {
    const { deps, session } = makeDeps({ session: makeSession({ id: 'existing', accountId: 'a1', contextTokens: 0 }) });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'abcd', agentId: 'agent1', freshSessionPrompt: 'full history one' });
    assert.equal(session.contextTokens, estimateTokens('full history one'));

    await ask({ prompt: 'a'.repeat(40), agentId: 'agent1', freshSessionPrompt: 'full history one and two' });
    assert.equal(session.contextTokens, estimateTokens('full history one and two'));
});

test('askDSStream: accumulation also counts the fresh prompt after a session recreate', async () => {
    const session = makeSession({ id: 'stale', accountId: 'a1', contextTokens: 0 });
    let n = 0;
    const { deps } = makeDeps({
        session,
        dsChatCompletionWithPow: async () => {
            n++;
            return n === 1
                ? { status: 400, ok: false, headers: { get: () => null }, text: async () => 'expired' }
                : { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
        },
    });
    const ask = createUpstreamSession(deps);
    const out = await ask({ prompt: 'delta', agentId: 'agent1', freshSessionPrompt: 'full conversation' });
    assert.equal(out.freshSessionReset, true);

    assert.equal(session.contextTokens, estimateTokens('full conversation'));
});

test('askDSStream: a failed completion does not accumulate context', async () => {
    const session = makeSession({ id: 'existing', accountId: 'a1', contextTokens: 42 });
    const { deps } = makeDeps({
        session,
        dsChatCompletionWithPow: async () => ({ status: 403, ok: false, headers: { get: () => null }, text: async () => 'denied' }),
    });
    const ask = createUpstreamSession(deps);
    await assert.rejects(() => ask({ prompt: 'delta', agentId: 'agent1' }));
    assert.equal(session.contextTokens, 42);
});

function throttleRecorder(granted = true) {
    const order = [];
    const calls = [];
    return {
        order,
        calls,
        slot: async (account, opts) => { order.push('slot'); calls.push({ account, opts }); return granted; },
    };
}

test('askDSStream: throttles before solving PoW', async () => {
    const rec = throttleRecorder();
    const { deps, calls } = makeDeps({ waitForCompletionSlot: rec.slot });
    deps.solvePowForPath = async () => { rec.order.push('pow'); return 'pow'; };
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });

    assert.deepEqual(rec.order, ['slot', 'pow']);
    assert.equal(calls.completions.length, 1);
});

test('askDSStream: creates a fresh session before solving PoW so the header stays fresh', async () => {

    const order = [];
    const { deps } = makeDeps();
    deps.createRemoteSession = async () => { order.push('create'); return 'sess-1'; };
    deps.solvePowForPath = async () => { order.push('pow'); return 'pow'; };
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.deepEqual(order, ['create', 'pow']);
});

test('askDSStream: forwards clientGone into the throttle', async () => {
    const rec = throttleRecorder();
    const { deps } = makeDeps({ waitForCompletionSlot: rec.slot });
    const ask = createUpstreamSession(deps);
    const clientGone = () => false;
    await ask({ prompt: 'hi', agentId: 'agent1', clientGone });
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].opts.clientGone, clientGone);
});

test('askDSStream: grows the throttle interval while the parent message id is unchanged', async () => {
    config.reload({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '6000' });
    const rec = throttleRecorder();
    const { deps } = makeDeps({
        session: makeSession({ id: 'existing', accountId: 'a1', parentMessageId: 10 }),
        waitForCompletionSlot: rec.slot,
    });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    await ask({ prompt: 'hi', agentId: 'agent1' });
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.deepEqual(rec.calls.map(c => c.opts.intervalMs), [6000, 12000, 18000]);
});

test('askDSStream: resets the throttle interval once the parent message id advances', async () => {
    config.reload({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '6000' });
    const rec = throttleRecorder();
    const session = makeSession({ id: 'existing', accountId: 'a1', parentMessageId: 10 });
    const { deps } = makeDeps({ session, waitForCompletionSlot: rec.slot });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    await ask({ prompt: 'hi', agentId: 'agent1' });
    session.parentMessageId = 11;
    await ask({ prompt: 'hi', agentId: 'agent1' });
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.deepEqual(rec.calls.map(c => c.opts.intervalMs), [6000, 12000, 6000, 12000]);
});

test('askDSStream: aborts with 429 when the post-recreate slot is not granted', async () => {
    let grants = 0;
    let powSolved = 0;
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 'stale', accountId: 'a1' }),
        waitForCompletionSlot: async () => ++grants === 1,
    });
    deps.solvePowForPath = async () => { powSolved++; return 'pow'; };
    deps.dsChatCompletionWithPow = async (args) => {
        calls.completions.push(args);
        return { status: 400, ok: false, headers: { get: () => null }, text: async () => 'expired' };
    };
    const ask = createUpstreamSession(deps);
    await assert.rejects(() => ask({ prompt: 'hi', agentId: 'agent1', freshSessionPrompt: 'fresh' }), /DS upstream HTTP 429/);
    assert.equal(powSolved, 1, 'no fresh PoW after a denied slot');
    assert.equal(calls.completions.length, 1);
});

test('askDSStream: aborts with 429 when no completion slot is granted', async () => {
    const rec = throttleRecorder(false);
    const { deps, calls } = makeDeps({ waitForCompletionSlot: rec.slot });
    let powSolved = false;
    deps.solvePowForPath = async () => { powSolved = true; return 'pow'; };
    const ask = createUpstreamSession(deps);
    await assert.rejects(() => ask({ prompt: 'hi', agentId: 'agent1' }), /DS upstream HTTP 429/);

    assert.equal(powSolved, false);
    assert.equal(calls.completions.length, 0);
});

test('askDSStream: works without a throttle dependency (backwards compatible)', async () => {
    const { deps, calls } = makeDeps();
    delete deps.waitForCompletionSlot;
    const ask = createUpstreamSession(deps);
    const out = await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.equal(out.promptUsed, 'hi');
    assert.equal(calls.completions.length, 1);
});

test('askDSStream: throttles a reused session too (not only the first call)', async () => {
    const rec = throttleRecorder();
    const { deps, calls } = makeDeps({
        session: makeSession({ id: 'existing', accountId: 'a1' }),
        waitForCompletionSlot: rec.slot,
    });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hi', agentId: 'agent1' });
    assert.equal(rec.calls.length, 1);
    assert.equal(calls.completions.length, 1);
});

test('askDSStream: refreshes the account token before creating a session', async () => {
    const order = [];
    const { deps, calls } = makeDeps({
        refreshAccountToken: async () => { order.push('refresh'); return true; },
        createRemoteSession: async () => { order.push('create'); calls.created++; return 'sess-' + calls.created; },
    });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hello', agentId: 'agent1' });
    assert.deepEqual(order, ['refresh', 'create']);
});

test('askDSStream: skips the token refresh when the client is gone', async () => {
    let refreshed = false;
    const { deps } = makeDeps({
        refreshAccountToken: async () => { refreshed = true; return true; },
    });
    const ask = createUpstreamSession(deps);
    await assert.rejects(
        () => ask({ prompt: 'hello', agentId: 'agent1', clientGone: () => true }),
        /DS upstream HTTP 429/
    );
    assert.equal(refreshed, false);
});

test('askDSStream: refreshes client headers before creating a session and can be skipped', async () => {
    const order = [];
    const { deps, calls } = makeDeps({
        refreshClientHeaders: async () => { order.push('headers'); },
        createRemoteSession: async () => { order.push('create'); calls.created++; return 'sess-' + calls.created; },
    });
    const ask = createUpstreamSession(deps);
    await ask({ prompt: 'hello', agentId: 'agent1' });
    assert.deepEqual(order, ['headers', 'create']);

    let refreshed = false;
    const skipped = makeDeps({ refreshClientHeaders: async () => { refreshed = true; } });
    const askSkipped = createUpstreamSession(skipped.deps);
    await assert.rejects(
        () => askSkipped({ prompt: 'hello', agentId: 'agent1', clientGone: () => true }),
        /DS upstream HTTP 429/
    );
    assert.equal(refreshed, false);
    assert.equal(skipped.calls.completions.length, 0);
});
