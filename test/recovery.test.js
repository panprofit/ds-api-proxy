'use strict';
// Tests for lib/recovery.js runWithRecovery. These inject fake askDSStream /
// readDSResponse functions and stub the accounts/sessions singletons so the
// control-flow (empty-retry, continuation, markup-completion, account
// rotation) is exercised without any network or HTTP server.

const { test } = require('node:test');
const assert = require('node:assert');

const accounts = require('../lib/accounts');
const sessions = require('../lib/sessions');
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
        maxEmptyRetries: 2,
        malformedCooldownMs: 5000,
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

test('runWithRecovery: empty response retries then succeeds on same account', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([
                { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null },
                { content: 'recovered', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'recovered');
        assert.equal(out.retryAttempt, 1);
    });
});

test('runWithRecovery: reasoning-only response is returned without cooling the account', async () => {
    // Reasoning present but no final content must NOT be treated as an empty
    // response: the account is healthy, so it must stay out of cooldown and
    // the response is returned as-is (content empty, reasoning filled).
    //
    // Reasoning-continuation is disabled here so the raw reasoning-only result
    // is observable; the auto-continue behaviour is covered below.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_REASONING_CONTINUATION: '0' }, async () => {
            let calls = 0;
            const ctx = baseCtx({
                askDSStream: async () => { calls++; return { resp: { body: {} }, account: a1, promptUsed: 'p', freshSessionReset: false }; },
                readDSResponse: async () => ({ content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, '');
            assert.equal(out.reasoningContent, 'thinking hard');
            // Only the initial call — no empty-retries were spent on it.
            assert.equal(calls, 1);
            // Account was not penalised.
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: empty response parks the account for the short recoverable window', async () => {
    // An empty stream must NOT use the long accountCooldownMs (10 min default).
    // It is a transient glitch, so the account gets the short malformedCooldownMs.
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        // Mirror the real selectAccountForSession: set the session's sticky
        // account so markAccountBroken() has an account to penalise.
        const accountStub = async (args) => {
            const session = sessions.getOrCreateAgentSession(args.agentId);
            session.accountId = a1.id;
            return { resp: { body: {} }, account: a1, promptUsed: args?.prompt || 'p', freshSessionReset: false };
        };
        const ctx = baseCtx({
            malformedCooldownMs: 5000,
            // Never wait out the short cooldown inside the test.
            deadlineHit: () => true,
            askDSStream: accountStub,
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        await runWithRecovery(ctx);
        const remaining = a1.cooldownUntil - Date.now();
        assert.ok(remaining > 0, 'account should be cooling down');
        assert.ok(remaining <= 6000, `cooldown should be ~5s, got ${remaining}ms`);
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

test('runWithRecovery: empty response on all accounts returns 429 terminal error', async () => {
    // The sole account starts already cooling down, so no rotation is possible
    // and the run must terminate with an error instead of retrying forever.
    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([cooling]),
            // Never wait for cooldowns in tests.
            deadlineHit: () => true,
            // Always empty -> exhausts maxEmptyRetries and account attempts.
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
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

test('runWithRecovery: unknown tool name is dropped but content is returned', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const content = '{"tool_call":{"name":"nope","arguments":{}}}';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            deadlineHit: () => true,
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        // Unknown tool: not exposed as toolCall, and NOT treated as malformed markup.
        assert.equal(out.ok, true);
        assert.equal(out.toolCall, null);
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

test('runWithRecovery: malformed markup recreates the session on the same account before rotating', async () => {
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

        // 3 resets on a1, then 3 on a2 before the terminal error.
        assert.equal(calls.length, 6);
        assert.deepEqual(calls.slice(0, 3).map(c => c.accountId), ['a1', 'a1', 'a1']);
        assert.deepEqual(calls.slice(3).map(c => c.accountId), ['a2', 'a2', 'a2']);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
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

test('runWithRecovery: successful completion clears the malformed-reset counter', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: sseOnce([{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(ctx.session.malformedResets, 0);
    });
});

test('runWithRecovery: clientGone during empty-retry aborts without error body', async () => {
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
            // Context-too-long is retried by the empty loop; cap retries so the
            // test does not sleep through the real backoff.
            maxEmptyRetries: 0,
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

test('backoffDelay: scales and caps at 3x', () => {
    const { backoffDelay } = require('../lib/recovery');
    assert.equal(backoffDelay(1, 100), 100);
    assert.equal(backoffDelay(4, 100), 300);
});

// --- reasoning-only auto-continuation ----------------------------------------

test('runWithRecovery: reasoning-only response is auto-continued into a final answer', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_REASONING_CONTINUATION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: 'Final answer.', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'Final answer.');
            assert.equal(out.reasoningContent, 'thinking hard');
            assert.equal(out.finishReason, 'stop');
            // Initial call + one reasoning-continuation round.
            assert.equal(calls.length, 2);
            assert.equal(calls[1].prompt, 'continue');
        });
    });
});

test('runWithRecovery: reasoning-only continuation that yields nothing stops without cooling', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_REASONING_CONTINUATION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            let calls = 0;
            const ctx = baseCtx({
                askDSStream: async () => { calls++; return { resp: { body: {} }, account: a1, promptUsed: 'p', freshSessionReset: false }; },
                readDSResponse: async () => ({ content: '', reasoningContent: 'still only thinking', messageId: 'm1', finishReason: 'stop', modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, '');
            // Reasoning from each bounded round is accumulated.
            assert.equal(out.reasoningContent, 'still only thinking\nstill only thinking\nstill only thinking');
            // Bounded: initial call + maxReasoningContinuation rounds, then stop.
            assert.equal(calls, 3);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

// --- auto-continuation / markup-completion / strict retry -------------------
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
    const saved = config.get();
    config.reload({ ...process.env, ...overrides });
    try {
        return await fn();
    } finally {
        config.reload({ ...process.env, DS_RECOVERY_RETRY_DELAY_MS: String(saved.recoveryRetryDelayMs),
            DS_MAX_CONTINUATION: String(saved.maxContinuation),
            DS_MAX_MARKUP_COMPLETION: String(saved.maxMarkupCompletion),
            DS_MAX_REASONING_CONTINUATION: String(saved.maxReasoningContinuation),
            DS_CONTINUATION_SIZE_THRESHOLD: String(saved.continuationSizeThreshold) });
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

test('runWithRecovery: markup completion repairs a truncated tool call', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const truncated = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}';
            const calls = [];
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: truncated, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: '}', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.toolCall);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: markup completion ignores a fenced restart', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const truncated = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}';
            const fenced = '```json\n{"tool_call"...';
            // A clean tool call for the later strict-retry pass, so the run
            // terminates deterministically with ok:true.
            const clean = '{"tool_call":{"name":"read","arguments":{"path":"/y"}}}';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([makeAccount('a1')]),
                readDSResponse: sseOnce([
                    { content: truncated, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: fenced, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: clean, reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            // The fenced completion must never be appended to the content.
            assert.ok(!out.fullContent.includes('```'), `fenced completion leaked into content: ${out.fullContent}`);
            assert.equal(out.fullContent, clean);
            assert.ok(out.toolCall);
            assert.deepEqual(JSON.parse(out.toolCall.arguments), { path: '/y' });
        });
    });
});

test('runWithRecovery: strict retry succeeds with a clean tool call after reset', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_MARKUP_COMPLETION: '0', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const truncated = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}';
            const clean = '{"tool_call":{"name":"read","arguments":{"path":"/y"}}}';
            const calls = [];
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: truncated, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: clean, reasoningContent: 'r', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.toolCall);
            assert.deepEqual(JSON.parse(out.toolCall.arguments), { path: '/y' });
            assert.equal(out.reasoningContent, 'r');
        });
    });
});

test('runWithRecovery: strict retry that stays broken returns 429 for the only account', async () => {
    // Sole account already cooling down so the terminal error path (not a
    // rotation) is what surfaces the 429.
    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        await withConfig({ DS_MAX_MARKUP_COMPLETION: '0', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
            const truncated = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                deadlineHit: () => true,
                askDSStream: askStub([cooling]),
                readDSResponse: async () => ({ content: truncated, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.status, 429);
            assert.equal(out.error.body.type, 'rate_limit_error');
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

test('runWithRecovery: unclosed-markup log carries a markup diagnostic summary', async () => {
    // A DSML opening tag that never closes: hasUnclosedToolMarkup() is true,
    // so runMarkupCompletion runs and must log the enriched diagnostic
    // (length/shape/dsmlTags/parse + head/tail) plus the markup-dump line.
    // Cap the completion rounds at 1 so the loop logs the diagnostic once
    // and then exits; deadlineHit must stay false or the loop is skipped.
    const config = require('../lib/config');
    config.reload({ ...process.env, DS_MAX_MARKUP_COMPLETION: '1' });
    try {
    await withAccounts([makeAccount('a1')], async () => {
        const lines = [];
        const content = '<|DSML|invoke name="read"><|DSML|parameter name="path">';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            log: (...args) => lines.push(args.join(' ')),
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        await runWithRecovery(ctx);
        const unclosed = lines.find(l => l.includes('Unclosed tool-call markup'));
        assert.ok(unclosed, 'expected an Unclosed tool-call markup log line');
        assert.match(unclosed, /shape=dsml/);
        assert.match(unclosed, /dsmlTags=/);
        assert.match(unclosed, /parse=/);
        assert.ok(lines.some(l => l.includes('Markup head=') && l.includes('tail=')), 'expected a head/tail diagnostic line');
    });
    } finally {
        config.reload();
    }
});

test('runWithRecovery: strict-retry log carries a markup diagnostic summary', async () => {
    // JSON-shaped markup that looks like a tool call but never parses. The
    // completion rounds are disabled (maxMarkupCompletion=0), so control
    // reaches runStrictToolRetry and the invalid/truncated log line.
    const config = require('../lib/config');
    config.reload({ ...process.env, DS_MAX_MARKUP_COMPLETION: '0' });
    try {
        await withAccounts([makeAccount('a1')], async () => {
            const lines = [];
            const content = '{"tool_call":{"name":"read","arguments":{"path":';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                log: (...args) => lines.push(args.join(' ')),
                askDSStream: askStub([makeAccount('a1')]),
                readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
            });
            await runWithRecovery(ctx);
            const strict = lines.find(l => l.includes('invalid/truncated'));
            assert.ok(strict, 'expected a Tool-call markup detected but invalid/truncated log line');
            assert.match(strict, /shape=json/);
            assert.match(strict, /parse=/);
            assert.ok(lines.some(l => l.includes('Markup head=') && l.includes('tail=')), 'expected a head/tail diagnostic line');
        });
    } finally {
        config.reload();
    }
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
        const ctx = baseCtx({
            askDSStream: accountStub,
            // Every read returns a non-empty reply: the default sseOnce fallback
            // is empty, which would trigger the empty-retry loop on the second
            // run and make extra upstream calls.
            readDSResponse: sseOnce(
                [{ content: 'ok', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }],
                { content: 'ok', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
            ),
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
