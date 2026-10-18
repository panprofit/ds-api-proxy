'use strict';
// Tests for lib/recovery.js runWithRecovery. These inject fake askDSStream /
// readDSResponse functions and stub the accounts/sessions singletons so the
// control-flow (empty-retry, continuation, account
// rotation) is exercised without any network or HTTP server.

const { test } = require('node:test');
const assert = require('node:assert');

const accounts = require('../lib/accounts');
const sessions = require('../lib/sessions');
const metrics = require('../lib/metrics');
const { runWithRecovery } = require('../lib/recovery');

// --- test helpers -----------------------------------------------------------

function makeAccount(id, { ready = true, cooldownUntil = 0 } = {}) {
    return {
        id,
        file: `/tmp/${id}.json`,
        config: { token: ready ? 't' : '', cookie: ready ? 'c' : '' },
        headers: {},
        cooldownUntil,
        failures: 0,
        lastUsedAt: 0,
    };
}

// Install `list` as the live accounts array for the duration of `fn` and
// restore the previous array afterwards. Must await the callback: a `finally`
// around `return fn()` would restore the accounts as soon as the async body
// returns its first promise, so every `await` inside would run with zero
// accounts installed.
async function withAccounts(list, fn) {
    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    accountsArr.push(...list);
    try {
        return await fn();
    } finally {
        accountsArr.length = 0;
        accountsArr.push(...saved);
    }
}

function resetSessions() {
    for (const key of [...sessions.getSessions().keys()]) sessions.getSessions().delete(key);
}

// A readDSResponse stub that returns a canned result once, then a default.
function sseOnce(results, fallback = { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }) {
    let i = 0;
    return async () => {
        if (i < results.length) return results[i++];
        return fallback;
    };
}

// askDSStream stub: returns { resp, account, promptUsed, freshSessionReset }.
// `resp.body` is opaque — readDSResponse is stubbed separately. Every call is
// recorded in `calls` so tests can assert on the options object.
function askStub(accountsSeq, calls = []) {
    let i = 0;
    return async (args) => {
        calls.push(args);
        const account = accountsSeq[Math.min(i, accountsSeq.length - 1)];
        i++;
        return { resp: { body: {} }, account, promptUsed: args?.prompt || 'p', freshSessionReset: false };
    };
}

function baseCtx(overrides = {}) {
    resetSessions();
    const session = sessions.getOrCreateAgentSession('test-agent');
    return {
        agentId: 'test-agent',
        agentTag: '[test-agent]',
        session,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        prompt: 'User: hi',
        systemPrompt: 'SYS',
        fileIds: [],
        clientGone: () => false,
        deadlineHit: () => false,
        log: () => {},
        ...overrides,
    };
}

// --- tests ------------------------------------------------------------------

test('runWithRecovery: happy path returns text content', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: 'Hello world', reasoningContent: 'think', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'Hello world');
        assert.equal(out.reasoningContent, 'think');
        assert.equal(out.finishReason, 'stop');
        assert.equal(out.toolCall, null);
    });
});

test('runWithRecovery: empty response rotates the account instead of retrying it', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        const calls = [];
        const ctx = baseCtx({
            askDSStream: askStub([a1, a2], calls),
            readDSResponse: sseOnce([
                { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null },
                { content: 'recovered', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'recovered');
        // One attempt on a1, then a rotation straight to a2: no same-account retry.
        assert.equal(calls.length, 2);
        // The failure is attributed to the session's sticky account, which the
        // stub never sets, so no account is cooled down here (the cooling path
        // is covered by the 'parks the account' test).
    });
});

test('runWithRecovery: reasoning-only response rotates the account without cooling it', async () => {
    // Reasoning present but no final content is not a broken account: the model
    // thought but emitted no visible answer. The account is rotated but neither
    // parked nor counted as failed.
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: 'Final answer.', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'Final answer.');
            // One attempt on a1, then a rotation straight to a2: no re-prompt.
            assert.equal(calls.length, 2);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: empty response rotates without parking the account', async () => {
    // An empty stream is a transient model/protocol glitch: the account is
    // rotated but neither cooled down nor counted as failed.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        // Mirror the real selectAccountForSession: set the session's sticky
        // account so a penalty, if any, would be attributable.
        const accountStub = async (args) => {
            const session = sessions.getOrCreateAgentSession(args.agentId);
            session.accountId = a1.id;
            return { resp: { body: {} }, account: a1, promptUsed: args?.prompt || 'p', freshSessionReset: false };
        };
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: accountStub,
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(a1.cooldownUntil, 0, 'empty response must not park the account');
        assert.equal(a1.failures, 0, 'empty response must not count a failure');
    });
});

test('runWithRecovery: DS generation_err outage does not cool down the account', async () => {
    // DS reports a brief outage as an in-band model error with
    // finish_reason=generation_err. That is NOT the account's fault, so
    // markAccountBroken must not be called (no cooldown, no failure count).
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: askStub([a1]),
            readDSResponse: async () => ({
                content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
            }),
        });
        await runWithRecovery(ctx);
        assert.equal(a1.cooldownUntil, 0, 'account must not be cooled down for a DS outage');
        assert.equal(a1.failures, 0, 'account must not accrue failures for a DS outage');
    });
});

test('runWithRecovery: DS generation_err retries the SAME account before giving up', async () => {
    // Every account shares the same upstream, so rotating on a DS outage just
    // reproduces the error. The loop must retry the current account
    // maxUpstreamRetries times, then try once in a fresh session, and only then
    // surface a 503 to the client. All attempts stay on a1 (never a2).
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '3', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            let rr = 0;
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                let account;
                if (session.accountId) {
                    account = [a1, a2].find(a => a.id === session.accountId) || a1;
                } else {
                    account = [a1, a2][rr % 2];
                    rr++;
                    session.accountId = account.id;
                }
                calls.push(account.id);
                if (!session.id) { session.id = `sess-${account.id}`; session.messageCount = 0; }
                return { resp: { body: {} }, account, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            const ctx = baseCtx({
                askDSStream: accountStub,
                readDSResponse: async () => ({
                    content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                    modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
                }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.status, 503);
            assert.equal(out.error.body.type, 'upstream_unavailable');
            assert.equal(out.error.body.upstream_retries, 3);
            // initial + 3 same-account retries + 1 fresh-session attempt,
            // all on a1 (never a2).
            assert.deepEqual(calls, ['a1', 'a1', 'a1', 'a1', 'a1']);
            // Neither account was penalised for the upstream outage.
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a2.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
            assert.equal(a2.failures, 0);
        });
    });
});

test('runWithRecovery: DS generation_err retries the last turn in the SAME remote session', async () => {
    // A transient DS outage must NOT recreate the remote session during the
    // same-session retries: the session is still valid, so those retries re-send
    // the last turn in place. Only the final fresh-session fallback (after the
    // same-session retries are exhausted) recreates it once.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            let created = 0;
            const seenSessionIds = [];
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                session.accountId = a1.id;
                if (!session.id) session.id = 'sess-' + (++created);
                seenSessionIds.push(session.id);
                return { resp: { body: {} }, account: a1, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            const ctx = baseCtx({
                askDSStream: accountStub,
                readDSResponse: async () => ({
                    content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                    modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
                }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.body.upstream_retries, 2);
            // initial + 2 same-session retries reuse sess-1; the fresh-session
            // fallback then creates sess-2 for one last attempt.
            assert.deepEqual(seenSessionIds, ['sess-1', 'sess-1', 'sess-1', 'sess-2']);
            assert.equal(created, 2, 'only the fresh-session fallback recreates the session');
        });
    });
});

test('runWithRecovery: DS generation_err falls back to one fresh-session attempt after same-session retries', async () => {
    // When the same-session retries are exhausted and DS still reports the
    // outage, the loop recreates the remote session once and retries with the
    // full context before surfacing the error. Asserted by session ids: the
    // first (maxUpstreamRetries+1) calls reuse sess-1, the final call uses the
    // freshly created sess-2, and only then does the loop give up.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            let created = 0;
            const seenSessionIds = [];
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                session.accountId = a1.id;
                if (!session.id) session.id = 'sess-' + (++created);
                seenSessionIds.push(session.id);
                return { resp: { body: {} }, account: a1, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            const ctx = baseCtx({
                askDSStream: accountStub,
                readDSResponse: async () => ({
                    content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                    modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
                }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.status, 503);
            assert.equal(out.error.body.type, 'upstream_unavailable');
            // initial + 1 same-session retry on sess-1, then 1 fresh-session
            // attempt on sess-2, then give up.
            assert.deepEqual(seenSessionIds, ['sess-1', 'sess-1', 'sess-2']);
            assert.equal(created, 2, 'exactly one session recreation for the fresh fallback');
        });
    });
});

test('runWithRecovery: DS generation_err stops immediately with 0 retries configured', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: async () => ({
                    content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                    modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
                }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.status, 503);
            assert.equal(out.error.body.upstream_retries, 0);
            // initial call + the single fresh-session fallback attempt.
            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: a muted body parks the account until mute_until and rotates', async () => {
    // DS answers a muted account with a plain JSON `user is muted` payload
    // instead of a stream. Retrying that account is pointless, so the loop must
    // park it until the reported mute_until and rotate to the next account.
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    const muteUntilSec = Math.floor(Date.now() / 1000) + 3600;
    const muted = { message: 'user is muted', muteUntil: muteUntilSec };
    await withAccounts([a1, a2], async () => {
        let first = true;
        const ctx = baseCtx({
            // Never wait out the cooldown inside the test.
            deadlineHit: () => true,
            askDSStream: async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                const acct = first ? a1 : a2;
                session.accountId = acct.id;
                first = false;
                return { resp: { body: {} }, account: acct, promptUsed: args?.prompt || 'p', freshSessionReset: false };
            },
            // First call is muted; second (rotated account) succeeds.
            readDSResponse: sseOnce([
                { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null, muted },
                { content: 'after rotation', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'after rotation');
        // a1 parked until the reported mute_until, not the short 5s window.
        const remaining = a1.cooldownUntil - Date.now();
        assert.ok(remaining > 3500 * 1000, `expected ~1h park, got ${remaining}ms`);
        assert.equal(a1.failures, 1);
    });
});

test('runWithRecovery: a muted body on all accounts returns 429 with mute_until', async () => {
    const a1 = makeAccount('a1');
    const muteUntilSec = Math.floor(Date.now() / 1000) + 3600;
    const muted = { message: 'user is muted', muteUntil: muteUntilSec };
    await withAccounts([a1], async () => {
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                session.accountId = a1.id;
                return { resp: { body: {} }, account: a1, promptUsed: args?.prompt || 'p', freshSessionReset: false };
            },
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null, muted }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
        assert.equal(out.error.body.mute_until, muteUntilSec);
        // The only account is parked until mute_until, so no account is
        // available: the terminal message is the all-cooling one.
        assert.equal(out.error.body.message, 'All auth accounts are muted or cooling down. Retry later.');
    });
});

test('runWithRecovery: empty response on all accounts returns 429 terminal error', async () => {
    // The sole account starts already cooling down, so no rotation is possible
    // and the run must terminate with an error instead of retrying forever.
    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([cooling]),
            // Never wait for cooldowns in tests.
            deadlineHit: () => true,
            // Always empty -> cools the account and exhausts the account budget.
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
    });
});

test('runWithRecovery: exhausting the account budget returns an error, not an empty ok:true', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([a1, a2]),
            deadlineHit: () => false,
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.ok(out.error, 'expected a terminal error body');
        assert.equal(out.error.body.account_attempts, 2);
    });
});

test('runWithRecovery: rotation stops once the rotation budget elapses', async () => {
    // Two accounts, both cooling down for a long time. With a tiny rotation
    // budget the loop must stop waiting out cooldowns and report a terminal
    // error instead of cycling until the (here never-hit) request deadline.
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ROTATION_BUDGET_MS: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const ctx = baseCtx({
                deadlineHit: () => false,
                askDSStream: askStub([a1, a2]),
                readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.ok(out.error, 'expected a terminal error body');
        });
    });
});

test('runWithRecovery: rotating to another account resets the transient-retry counter', async () => {
    // The same-session upstream-retry budget is tracked per account via
    // state.upstreamRetryAccountId. When a rotation lands on a DIFFERENT account
    // the counter must restart from zero, so the new account gets its full
    // DS_MAX_UPSTREAM_RETRIES budget instead of inheriting the previous one's.
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '3', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            let rr = 0;
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                let account;
                if (session.accountId) {
                    account = [a1, a2].find(a => a.id === session.accountId) || a1;
                } else {
                    account = [a1, a2][rr % 2];
                    rr++;
                    session.accountId = account.id;
                }
                if (!session.id) { session.id = `sess-${account.id}`; session.messageCount = 0; }
                return { resp: { body: {} }, account, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            // 1) a1 hits one transient outage (budget counter -> 1 on a1).
            // 2) a1 then returns a plain empty body, which rotates to a2.
            // 3+) a2 hits the same transient outage and must get a fresh budget.
            const transient = () => ({
                content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
            });
            const empty = () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null });
            const results = [transient(), empty(), transient(), transient(), transient(), transient(), transient()];
            let i = 0;
            const ctx = baseCtx({
                askDSStream: accountStub,
                readDSResponse: async () => results[Math.min(i++, results.length - 1)],
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.body.type, 'upstream_unavailable');
            // If the counter had NOT reset on rotation, a2 would have inherited
            // a1's single retry and given up after 2; the reset lets it spend the
            // full 3. This is the observable difference.
            assert.equal(out.error.body.upstream_retries, 3);
            assert.equal(out.error.body.account, 'a2');
        });
    });
});
test('runWithRecovery: parses a strict JSON tool call', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const content = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.ok(out.toolCall);
        assert.equal(out.toolCall.name, 'read');
        assert.deepEqual(JSON.parse(out.toolCall.arguments), { path: '/x' });
    });
});

test('runWithRecovery: unknown tool name is not leaked as text (rotation unavailable)', async () => {
    // With the client gone, rotation cannot proceed, so the request must end in
    // a terminal `unknown_tool` error — NOT as ok:true with the raw markup
    // returned as text.
    await withAccounts([makeAccount('a1')], async () => {
        const content = '{"tool_call":{"name":"nope","arguments":{}}}';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            clientGone: () => true,
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 502);
        assert.equal(out.error.body.type, 'unknown_tool');
        assert.equal(out.error.body.requested_tool, 'nope');
        assert.deepEqual(out.error.body.available_tools, ['read']);
    });
});

test('runWithRecovery: unknown tool rotates the account immediately', async () => {
    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    accountsArr.push(a1, a2);
    try {
        await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const unknown = '{"tool_call":{"name":"nope","arguments":{}}}';
            const valid = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
            const calls = [];
            let rr = 0;
            // Sticky like selectAccountForSession: reuse session.accountId when set.
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                let account;
                if (session.accountId) {
                    account = accountsArr.find(a => a.id === session.accountId) || accountsArr[0];
                } else {
                    account = accountsArr[rr % accountsArr.length];
                    rr++;
                    session.accountId = account.id;
                }
                calls.push({ accountId: account.id, prompt: args.prompt });
                return { resp: { body: {} }, account, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: accountStub,
                readDSResponse: sseOnce([
                    { content: unknown, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: valid, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2);
            // The retry goes to the next account, not the one that hallucinated.
            assert.deepEqual(calls.map(c => c.accountId), ['a1', 'a2']);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    } finally {
        accountsArr.length = 0;
        accountsArr.push(...saved);
    }
});

test('runWithRecovery: terminal unknown tool increments the unknownTool metric', async () => {
    // The metric is the operational signal for the give-up path, so it must be
    // counted exactly once. request-path code calls the re-exported metrics.inc,
    // so that is what has to be swapped here (swapping metrics.instance would
    // not be seen).
    const real = metrics.inc;
    const counted = [];
    metrics.inc = (name) => counted.push(name);
    try {
        await withAccounts([makeAccount('a1')], async () => {
            const content = '{"tool_call":{"name":"nope","arguments":{}}}';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                // The client is gone, so rotation cannot wait for an account.
                clientGone: () => true,
                askDSStream: askStub([makeAccount('a1')]),
                readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.body.type, 'unknown_tool');
            assert.equal(counted.filter(n => n === 'unknownTool').length, 1);
        });
    } finally {
        metrics.inc = real;
    }
});

test('runWithRecovery: unknown tool on the only (cooling) account reports all-cooling (429)', async () => {
    // The sole account is already cooling down, so hasAvailableAccount() is
    // false and the terminal branch reports a 429.
    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const content = '{"tool_call":{"name":"nope","arguments":{}}}';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            deadlineHit: () => true,
            askDSStream: askStub([cooling]),
            readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
    });
});

test('runWithRecovery: malformed markup on the only account reports all-cooling (429)', async () => {
    // Markup that looksLikeToolCallMarkup but never parses. The sole account is
    // already cooling down (installed in the live accounts array), so
    // hasAvailableAccount() is false and the terminal branch reports a 429.
    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const content = '<tool_call>{"name":"read","arguments":{"path":';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            deadlineHit: () => true,
            askDSStream: askStub([cooling]),
            readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
    });
});

test('runWithRecovery: malformed markup rotates the account immediately', async () => {
    // NOTE: managed by hand (not withAccounts) because the live accounts array
    // must stay populated for the whole async run — withAccounts restores it
    // as soon as the async callback returns its first promise.
    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    accountsArr.push(makeAccount('a1'), makeAccount('a2'));
    try {
        // Mimics selectAccountForSession: sticky account if set, otherwise
        // round-robin, and creates a remote session id on first use.
        const calls = [];
        let rr = 0;
        const accountStub = async (args) => {
            const session = sessions.getOrCreateAgentSession(args.agentId);
            let account;
            if (session.accountId) {
                account = accountsArr.find(a => a.id === session.accountId) || accountsArr[0];
            } else {
                account = accountsArr[rr % accountsArr.length];
                rr++;
                session.accountId = account.id;
            }
            calls.push({ prompt: args.prompt, accountId: account.id });
            if (!session.id) { session.id = `sess-${Math.random().toString(36).slice(2)}`; session.messageCount = 0; }
            return { resp: { body: {} }, account, promptUsed: args.prompt || 'p', freshSessionReset: false };
        };

        const malformed = '<tool_call>{"name":"read","arguments":{"path":';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            // Never wait for cooldowns; hasAvailableAccount() is still checked
            // first, so the a1->a2 rotation happens immediately.
            deadlineHit: () => true,
            askDSStream: accountStub,
            readDSResponse: async () => ({ content: malformed, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        const out = await runWithRecovery(ctx);

        // One attempt per account: no same-account retry, no session recreation.
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map(c => c.accountId), ['a1', 'a2']);
        assert.equal(out.ok, false);
        // No cooldown is applied, so the remaining account stays available and
        // the terminal failure is a 502, not an all-cooling 429. The account
        // budget runs out on the final rotation, so the shared terminal builds
        // the body: the type falls back to 'empty_response' (state.modelError
        // is null), not the phase's 'malformed_tool_call'.
        assert.equal(out.error.status, 502);
        assert.equal(out.error.body.type, 'empty_response');
    } finally {
        accountsArr.length = 0;
        accountsArr.push(...saved);
    }
});

// Regression: "Auth may be expired, captcha may be required, or DS changed
// Web API" must NOT be retried on the same account. runWithRecovery has to
// cool the dead account down and rotate to the next healthy one.
test('runWithRecovery: auth_expired rotates to the next account and succeeds', async () => {
    // Manual accounts management: the live array must stay populated for the
    // whole async run (withAccounts restores it as soon as the callback returns
    // its first promise).
    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    accountsArr.push(makeAccount('a1'), makeAccount('a2'));
    try {
        const calls = [];
        let rr = 0;
        const accountStub = async (args) => {
            const session = sessions.getOrCreateAgentSession(args.agentId);
            let account;
            if (session.accountId) {
                account = accountsArr.find(a => a.id === session.accountId) || accountsArr[0];
            } else {
                account = accountsArr[rr % accountsArr.length];
                rr++;
                session.accountId = account.id;
            }
            calls.push({ accountId: account.id });
            if (account.id === 'a1') {
                const err = new Error('Could not create DS chat session (HTTP 401). Auth may be expired/captcha-blocked.');
                err.type = 'auth_expired';
                err.status = 401;
                throw err;
            }
            if (!session.id) { session.id = `sess-${account.id}`; session.messageCount = 0; }
            return { resp: { body: {} }, account, promptUsed: args.prompt || 'p', freshSessionReset: false };
        };
        const ctx = baseCtx({
            askDSStream: accountStub,
            readDSResponse: sseOnce([{ content: 'ok from a2', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'ok from a2');
        // a1 failed with the auth error, then rotated to a2 for the retry.
        assert.deepEqual(calls.map(c => c.accountId), ['a1', 'a2']);
        // The dead account must be cooling down afterwards.
        const a1 = accountsArr.find(a => a.id === 'a1');
        assert.ok(a1.cooldownUntil > Date.now(), 'a1 should be in cooldown after the auth error');
    } finally {
        accountsArr.length = 0;
        accountsArr.push(...saved);
    }
});

test('runWithRecovery: auth_expired on the only account returns a terminal error', async () => {
    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    accountsArr.push(makeAccount('a1'));
    try {
        const accountStub = async (args) => {
            const session = sessions.getOrCreateAgentSession(args.agentId);
            const account = accountsArr[0];
            session.accountId = account.id;
            const err = new Error('DS PoW response has no data.biz_data.challenge. Auth may be expired, captcha may be required, or DS changed Web API.');
            err.type = 'auth_expired';
            err.status = 401;
            throw err;
        };
        const ctx = baseCtx({
            // Never wait out the cooldown in tests.
            deadlineHit: () => true,
            askDSStream: accountStub,
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        // No healthy account is left, so the terminal error is the rate-limit
        // body rather than a bare 401.
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
        assert.equal(out.error.body.account, 'a1');
    } finally {
        accountsArr.length = 0;
        accountsArr.push(...saved);
    }
});

test('runWithRecovery: clientGone while rotating after an empty response aborts without error body', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        let gone = false;
        const ctx = baseCtx({
            clientGone: () => gone,
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: async () => {
                gone = true; // disconnect right after the first empty response
                return { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null };
            },
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.clientGone, true);
    });
});

test('runWithRecovery: thinkingEnabled is forwarded to askDSStream', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const calls = [];
        const ctx = baseCtx({
            thinkingEnabled: true,
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].thinkingEnabled, true);
        assert.ok(calls[0].prompt.includes('User: hi'));
        assert.equal(calls[0].agentId, 'test-agent');
    });
});

test('runWithRecovery: thinkingEnabled defaults to undefined when not provided', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const calls = [];
        const ctx = baseCtx({
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        await runWithRecovery(ctx);
        assert.equal(calls[0].thinkingEnabled, undefined);
    });
});

test('runWithRecovery: fileIds is forwarded to askDSStream', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const calls = [];
        const ctx = baseCtx({
            fileIds: ['f1', 'f2'],
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        await runWithRecovery(ctx);
        assert.deepEqual(calls[0].fileIds, ['f1', 'f2']);
    });
});

test('runWithRecovery: context-too-long model error is surfaced as 400', async () => {
    // Sole account already cooling down so the terminal error path (not a
    // rotation) is what surfaces the 400.
    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: askStub([cooling]),
            readDSResponse: async () => ({
                content: '', reasoningContent: '', messageId: 'm1', finishReason: null,
                modelError: { type: 'error', content: 'context too long', finish_reason: null },
            }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.ok([400, 429].includes(out.error.status));
    });
});

test('runWithRecovery: context-too-long skips empty retries (deterministic failure)', async () => {
    // Resending the same prompt to the same session cannot fix a context-limit
    // error, so the empty-retry loop must not run: exactly one upstream call
    // (the initial attempt) and retry_attempts == 0.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: askStub([a1], calls),
            readDSResponse: async () => ({
                content: '', reasoningContent: '', messageId: 'm1', finishReason: null,
                modelError: { type: 'error', content: 'context too long', finish_reason: null },
            }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(calls.length, 1, 'context-too-long must not be retried');
        assert.equal(out.error.body.type, 'context_length_exceeded');
    });
});

test('backoffDelay: scales and caps at 3x', () => {
    const { backoffDelay } = require('../lib/recovery');
    assert.equal(backoffDelay(1, 100), 100);
    assert.equal(backoffDelay(4, 100), 300);
});

// --- reasoning-only rotation -------------------------------------------------

test('runWithRecovery: reasoning-only response rotates instead of re-prompting', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: 'Final answer.', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'Final answer.');
            assert.equal(calls.length, 2);
            // The retry is a plain fresh attempt, not a "final answer" re-prompt:
            // the second call carries no continuation instruction.
            assert.equal(calls[1].prompt, calls[0].prompt);
            assert.doesNotMatch(calls[1].prompt, /final answer/i);
        });
    });
});

test('runWithRecovery: reasoning-only response gives up with a terminal 502 when rotation is impossible', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const ctx = baseCtx({
            clientGone: () => true,
            askDSStream: askStub([a1], calls),
            readDSResponse: sseOnce([
                { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(calls.length, 1);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 502);
        assert.equal(out.error.body.type, 'reasoning_only');
        assert.equal(a1.cooldownUntil, 0);
    });
});


// --- auto-continuation -----------------------------------------------------
//
// These passes are driven through runWithRecovery: the injected
// readDSResponse returns length-finished content or truncated tool-call
// markup, and config.reload() shrinks the continuation limits and the retry
// delay so the loops finish instantly.

const config = require('../lib/config');

// Reload config for the duration of `fn` (which may be async) and restore it
// afterwards. Must await the callback: a `finally` around `return fn()` would
// restore config as soon as the promise is *created*, not when it settles,
// which silently reverts the overrides mid-run.
async function withConfig(overrides, fn) {
    config.reload(overrides);
    try {
        return await fn();
    } finally {
        // process.env is never mutated by tests, so reloading from it restores
        // the pre-test config exactly (no per-field snapshot needed).
        config.reload();
    }
}

test('runWithRecovery: auto-continuation appends the continuation and updates finishReason', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_CONTINUATION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: 'part1', reasoningContent: '', messageId: 'm1', finishReason: 'length', modelError: null },
                    { content: 'part2', reasoningContent: 'r2', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'part1\npart2');
            assert.equal(out.reasoningContent, 'r2');
            assert.equal(out.finishReason, 'stop');
            // Initial call + one continuation round.
            assert.equal(calls.length, 2);
            assert.equal(calls[1].prompt, 'continue');
        });
    });
});

test('runWithRecovery: a refusal continuation is not appended', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_CONTINUATION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')]),
                readDSResponse: sseOnce([
                    { content: 'part1', reasoningContent: '', messageId: 'm1', finishReason: 'length', modelError: null },
                    { content: 'I am an AI and cannot continue.', reasoningContent: '', messageId: 'm2', finishReason: 'length', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'part1');
        });
    });
});

test('runWithRecovery: continuation that rotates account is skipped and session reset', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_CONTINUATION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            let call = 0;
            const ctx = baseCtx({
                askDSStream: async (args) => {
                    call++;
                    // First call stays on a1; the continuation reports a2.
                    const account = call === 1 ? makeAccount('a1') : makeAccount('a2');
                    return { resp: { body: {} }, account, promptUsed: args.prompt, freshSessionReset: false };
                },
                readDSResponse: sseOnce([
                    { content: 'part1', reasoningContent: '', messageId: 'm1', finishReason: 'length', modelError: null },
                ]),
            });
            // Pin the session account so contBeforeId is a1.
            ctx.session.accountId = 'a1';
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'part1');
        });
    });
});

test('runWithRecovery: MEDIA paths from tool results are injected when absent', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        // extractScreenshotPaths() stats the path with the real fs, so create a
        // real temp image for the extraction to accept it.
        const os = require('node:os');
        const fsp = require('node:fs');
        const imagePath = require('node:path').join(os.tmpdir(), `ds-recovery-${process.pid}.png`);
        fsp.writeFileSync(imagePath, 'x');
        try {
            const ctx = baseCtx({
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'tool', content: JSON.stringify({ screenshot_path: imagePath }) },
                ],
                askDSStream: askStub([makeAccount('a1')]),
                readDSResponse: sseOnce([{ content: 'done', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.fullContent.includes(`MEDIA:${imagePath}`));
        } finally {
            fsp.unlinkSync(imagePath);
        }
    });
});

// --- incremental-turn bookkeeping -------------------------------------------

test('runWithRecovery: a fresh session marks every turn sent', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(ctx.session.sentKeys.size, 2);
    });
});

test('runWithRecovery: a reused session forwards only pending turns', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const calls = [];
        // Mimics selectAccountForSession: creates a remote session id on first
        // use so the second run sees a reused session (session.id set).
        const accountStub = async (args) => {
            const s = sessions.getOrCreateAgentSession(args.agentId);
            calls.push({ prompt: args.prompt });
            if (!s.id) { s.id = 'sess-1'; s.messageCount = 0; }
            return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false };
        };
        let reads = 0;
        // Mimics readDSResponse: an accepted turn advances the session, which
        // is what marks the remote session reusable on the next run.
        const readStub = async () => {
            const s = sessions.getOrCreateAgentSession('test-agent');
            const result = { content: 'ok', reasoningContent: '', messageId: `m${++reads}`, finishReason: 'stop', modelError: null };
            s.parentMessageId = result.messageId;
            s.messageCount++;
            return result;
        };
        const ctx = baseCtx({
            askDSStream: accountStub,
            readDSResponse: readStub,
        });
        // First run forwards the full conversation and marks it sent.
        await runWithRecovery(ctx);
        calls.length = 0;
        // Second run with a new user turn: only that turn is pending.
        ctx.messages = [{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }];
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(calls.length, 1);
        assert.match(calls[0].prompt, /again/);
        assert.doesNotMatch(calls[0].prompt, /User: hi/);
        assert.equal(ctx.session.sentKeys.size, 2);
    });
});

test('runWithRecovery: a session with no accepted turn is treated as fresh', async () => {
    // Regression: a generation_err on a session's FIRST completion leaves
    // session.id set while messageCount stays 0 — the remote session never
    // accepted the system prompt (tool definitions ride with it). The
    // transient retry must re-send the full prompt; a delta-only one would
    // leave the model without tool definitions for the rest of the session.
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err', modelError: { type: 'server_error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' } },
                    { content: 'ok', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            // Seed the poisoned state after baseCtx: a remote session id exists
            // but no turn was ever accepted into it.
            ctx.session.id = 'sess-empty';
            ctx.session.accountId = 'a1';
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(calls.length, 2, 'the initial attempt plus one same-session retry');
            assert.match(calls[1].prompt, /SYS/, 'the retry must re-send the system prompt the empty session never saw');
            assert.match(calls[1].prompt, /User: hi/);
            assert.equal(out.reusingRemoteSession, false);
        });
    });
});

test('runWithRecovery: logs the incremental-prompt diagnostic on the first (fresh-session) turn', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const lines = [];
        // Mimics selectAccountForSession: no session.id yet, so the first run
        // takes the fresh-session branch that used to skip the diagnostic.
        const accountStub = async (args) => {
            const s = sessions.getOrCreateAgentSession(args.agentId);
            if (!s.id) { s.id = 'sess-1'; s.messageCount = 0; }
            return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false };
        };
        const ctx = baseCtx({
            askDSStream: accountStub,
            readDSResponse: sseOnce([{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
            log: (...args) => lines.push(args.join(' ')),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        const line = lines.find(l => l.includes('Incremental prompt:'));
        assert.ok(line, 'expected the Incremental prompt log line on the first turn');
        assert.match(line, /1 pending turn\(s\)/);
    });
});

// --- stop sequences ---------------------------------------------------------

test('runWithRecovery: stop sequence truncates the visible content', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            stop: ['STOP'],
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: 'Hello STOP world', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'Hello ');
    });
});

test('runWithRecovery: earliest of multiple stop sequences wins', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            stop: ['END', 'STOP'],
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: 'a END b STOP c', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.fullContent, 'a ');
    });
});

test('runWithRecovery: no stop match leaves the content intact', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            stop: ['NOPE'],
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: 'Hello world', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.fullContent, 'Hello world');
    });
});

test('runWithRecovery: stop does not truncate a tool call', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const toolJson = '{"tool_call":{"name":"bash","arguments":{"command":"ls"}}}';
        const ctx = baseCtx({
            stop: ['bash'],
            tools: [{ type: 'function', function: { name: 'bash' } }],
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: toolJson, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.ok(out.toolCall, 'tool call should still parse');
        assert.equal(out.toolCall.name, 'bash');
    });
});

// --- action-promise rotation -----------------------------------------------
// A reasoning block followed by a SHORT final line ("Let me check the tests")
// with a clean end and no tool call used to strand the client: phaseReasoningOnly
// needs an EMPTY body and runAutoContinuation needs finish=length or >25k chars.
// phaseActionPromise rotates the account instead of re-prompting.

test('runWithRecovery: short action-promise rotates to the next account and yields the tool call', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const promise = 'Let me check the tests.';
            const toolJson = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: promise, reasoningContent: 'I should look at the tests first.', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: toolJson, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.toolCall, 'the promised action must become a real tool call');
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2, 'one attempt on a1, then a rotation to a2');
            // The retry is a plain fresh attempt, not a corrective re-prompt.
            assert.equal(calls[1].prompt, calls[0].prompt);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: an action-promise with no finish_reason still rotates and yields the tool call', async () => {
    // DS's current flow ends clean turns with `response/status: FINISHED` and
    // never sends `response/finish_reason`, so a null finish reason must count
    // as a clean stop or this phase stays dead in production.
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const promise = 'Let me check the tests.';
            const toolJson = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: promise, reasoningContent: 'I should look at the tests first.', messageId: 'm1', finishReason: null, modelError: null },
                    { content: toolJson, reasoningContent: '', messageId: 'm2', finishReason: null, modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.toolCall, 'the promised action must become a real tool call');
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2, 'one attempt on a1, then a rotation to a2');
            assert.equal(calls[1].prompt, calls[0].prompt);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: short real answer (no promise marker) does NOT continue', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const calls = [];
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([
                { content: 'Done.', reasoningContent: 'Everything is in order.', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'Done.');
        assert.equal(calls.length, 1, 'a real short answer must not be re-prompted');
    });
});

test('runWithRecovery: promise marker on a LONG body does not continue', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const calls = [];
        const long = 'Let me walk through the whole approach. '.repeat(30);
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([
                { content: long, reasoningContent: 'reasoning here', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(calls.length, 1, 'a body over actionPromiseMaxChars is not a promise');
    });
});

// --- branch-isolated recovery paths -----------------------------------------

test('runWithRecovery: rate-limit empty response cools the account via the Retry-After path', async () => {
    // A rate-limit model error must take the markAccountFailure(429) branch,
    // not the short recoverable-failure cooldown used for an empty stream.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        // deadlineHit=true stops the rotation loop from waiting out the cooldown.
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: askStub([a1]),
            readDSResponse: sseOnce([{
                content: '',
                reasoningContent: '',
                messageId: 'm1',
                finishReason: 'rate_limit_reached',
                modelError: { type: 'rate_limit', content: 'too many requests', finish_reason: 'rate_limit_reached' },
            }]),
        });
        ctx.session.accountId = a1.id;
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.body.type, 'rate_limit_error');
        assert.ok(a1.failures >= 1, 'rate-limit path must count a failure');
        assert.ok(a1.cooldownUntil > Date.now(), 'account must be cooled down');
    });
});

test('runWithRecovery: context-too-long stops empty-retries before burning one', async () => {
    // The context-too-long guard fires before the generic modelError break, so
    // a deterministic failure never issues a retry.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const ctx = baseCtx({
            askDSStream: askStub([a1], calls),
            readDSResponse: sseOnce([{
                content: '',
                reasoningContent: '',
                messageId: null,
                finishReason: null,
                modelError: { type: 'error', content: 'maximum context length exceeded', finish_reason: null },
            }]),
        });
        ctx.session.accountId = a1.id;
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.body.type, 'context_length_exceeded');
        assert.equal(calls.length, 1, 'no retry must be issued for a deterministic context-too-long');
    });
});

test('runWithRecovery: action-promise gives up with a terminal 502 when rotation is impossible', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            // The client is gone, so rotation cannot wait for an account.
            clientGone: () => true,
            askDSStream: askStub([a1], calls),
            readDSResponse: sseOnce([
                { content: 'Let me check the tests.', reasoningContent: 'I should look at the tests.', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(calls.length, 1);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 502);
        assert.equal(out.error.body.type, 'action_promise');
        assert.equal(a1.cooldownUntil, 0);
    });
});

// HTTP 429 from the upstream is NOT treated as a rotation trigger: unlike a
// 401/403 auth failure, typeForStatus() maps it to 'rate_limit_error', which
// handleAuthExpired() deliberately does not catch. The error is re-thrown and
// handlers.writeError() forwards it to the client with the Retry-After header.
// The account itself is already cooled down by upstream-session's
// markAccountFailure() before the throw, so a later request rotates away from
// it. A 429 therefore fails THIS request instead of silently retrying on
// another account (a DS 429 is not guaranteed to be account-scoped).
test('runWithRecovery: an upstream HTTP 429 propagates to the caller instead of rotating', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const { createUpstreamHttpError } = require('../lib/http');
        const accountStub = async (args) => {
            const session = sessions.getOrCreateAgentSession(args.agentId);
            session.accountId = a1.id;
            throw createUpstreamHttpError(429, 'rate limited', '120');
        };
        const ctx = baseCtx({
            deadlineHit: () => true,
            askDSStream: accountStub,
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        await assert.rejects(
            () => runWithRecovery(ctx),
            (e) => {
                assert.equal(e.status, 429);
                assert.equal(e.type, 'rate_limit_error');
                assert.equal(e.retryAfter, '120');
                return true;
            },
        );
    });
});

test('runWithRecovery: a native <tool_result> echo rotates to the next account and delivers the real answer', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const echo = '<tool_result>\nFAKE OUTPUT\n</tool_result>';
            const ctx = baseCtx({
                askDSStream: askStub([a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: echo, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: 'the real answer', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'the real answer');
            assert.doesNotMatch(out.fullContent, /FAKE OUTPUT/);
            assert.equal(calls.length, 2);
            assert.equal(a1.failures, 0);
            assert.equal(a1.cooldownUntil, 0);
        });
    });
});

test('runWithRecovery: a native <tool_result> echo gives up with a terminal 502 when rotation is impossible', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const echo = '<tool_result>\nFAKE OUTPUT\n</tool_result>';
        const ctx = baseCtx({
            // The client is gone, so rotation cannot wait for an account and the
            // phase must not hang.
            clientGone: () => true,
            askDSStream: askStub([a1], calls),
            readDSResponse: sseOnce([
                { content: echo, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(calls.length, 1);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 502);
        assert.equal(out.error.body.type, 'tool_result_echo');
        // a1 is available, so this is not the all-cooling 429 path.
        assert.equal(a1.cooldownUntil, 0);
    });
});
