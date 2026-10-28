'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const accounts = require('../lib/accounts');
const sessions = require('../lib/sessions');
const metrics = require('../lib/metrics');
const { runWithRecovery } = require('../lib/recovery');

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

function sseOnce(results, fallback = { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }) {
    let i = 0;
    return async () => {
        if (i < results.length) return results[i++];
        return fallback;
    };
}

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
        log: () => {},
        ...overrides,
    };
}

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

test('runWithRecovery: forwards live reasoning deltas to readDSResponse', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const deltas = [];
        const ctx = baseCtx({
            onReasoningDelta: (delta) => deltas.push(delta),
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: async (body, session, agentTag, options) => {
                options.onReasoningDelta('think');
                return { content: 'Hello world', reasoningContent: 'think', messageId: 'm1', finishReason: 'stop', modelError: null };
            },
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.deepEqual(deltas, ['think']);
    });
});

test('runWithRecovery: empty response rotates the account instead of retrying it', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: a single account retries an empty response in a fresh session', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_SAME_ACCOUNT_RETRIES: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null },
                    { content: 'recovered', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'recovered');
            assert.equal(calls.length, 2, 'the sole account gets one same-account retry');
            assert.equal(a1.failures, 0);
            assert.equal(a1.cooldownUntil, 0);
        });
    });
});

test('runWithRecovery: a single account continues reasoning-only turns until a visible answer', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: '', reasoningContent: 'still thinking', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: 'final answer', reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'final answer');
            assert.equal(calls.length, 3);
            assert.equal(calls[1].prompt, 'continue');
            assert.equal(calls[2].prompt, 'continue');
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: same-account retries are bounded by DS_MAX_SAME_ACCOUNT_RETRIES', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_SAME_ACCOUNT_RETRIES: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(calls.length, 2, 'initial attempt + exactly one retry');
        });
    });
});

test('runWithRecovery: a completion timeout is recoverable and rotates to the next account', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: async (args) => {
                    calls.push(args);
                    if (calls.length === 1) {
                        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
                    }
                    return { resp: { body: {} }, account: a2, promptUsed: args.prompt || 'p', freshSessionReset: false };
                },
                readDSResponse: sseOnce([{ content: 'recovered after timeout', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'recovered after timeout');
            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: reasoning-only response continues in the same session without rotating', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const deltas = [];
            let reads = 0;
            const ctx = baseCtx({
                thinkingEnabled: true,
                onReasoningDelta: (delta) => deltas.push(delta),
                askDSStream: askStub([a1], calls),
                readDSResponse: async (body, session, agentTag, options) => {
                    const index = reads++;
                    if (index === 1) options.onReasoningDelta('continued reasoning');
                    return [
                        { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                        { content: 'Final answer.', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    ][index];
                },
            });
            ctx.session.accountId = a1.id;
            ctx.session.id = 'remote-1';
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'Final answer.');

            assert.equal(calls.length, 2);
            assert.equal(calls[1].prompt, 'continue');
            assert.equal(calls[1].thinkingEnabled, true, 'reasoning-only continuation keeps thinking');
            assert.deepEqual(deltas, ['continued reasoning'], 'continuation reasoning is streamed live');
            assert.match(calls[1].freshSessionPrompt, /provide the final answer now/i);
            assert.equal(ctx.session.id, 'remote-1', 'the remote session is kept');
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: empty response rotates without parking the account', async () => {

    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                session.accountId = a1.id;
                return { resp: { body: {} }, account: a1, promptUsed: args?.prompt || 'p', freshSessionReset: false };
            };
            const ctx = baseCtx({
                askDSStream: accountStub,
                readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(a1.cooldownUntil, 0, 'empty response must not park the account');
            assert.equal(a1.failures, 0, 'empty response must not count a failure');
        });
    });
});

test('runWithRecovery: DS generation_err outage does not cool down the account', async () => {

    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const ctx = baseCtx({
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
});

test('runWithRecovery: DS generation_err retries the SAME account before giving up', async () => {

    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '3', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.deepEqual(calls, ['a1', 'a1', 'a1', 'a1', 'a1']);

            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a2.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
            assert.equal(a2.failures, 0);
        });
    });
});

test('runWithRecovery: no thinking fallback without reasoning or tools', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '0', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                tools: [],
                thinkingEnabled: true,
                askDSStream: askStub([a1], calls),
                readDSResponse: async () => ({
                    content: '', reasoningContent: 'I should use bash.', messageId: 'm1', finishReason: 'generation_err',
                    modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
                }),
            });
            await runWithRecovery(ctx);

            assert.equal(calls.length, 4);
            assert.equal(calls[0].thinkingEnabled, true);
            assert.equal(calls[1].prompt, 'continue');
            assert.equal(calls[2].thinkingEnabled, true);
            assert.equal(calls[3].thinkingEnabled, true);
        });
    });
});

test('runWithRecovery: DS generation_err retries the last turn in the SAME remote session', async () => {

    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '2', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.deepEqual(seenSessionIds, ['sess-1', 'sess-1', 'sess-1', 'sess-2']);
            assert.equal(created, 2, 'only the fresh-session fallback recreates the session');
        });
    });
});

test('runWithRecovery: DS generation_err falls back to one fresh-session attempt after same-session retries', async () => {

    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.deepEqual(seenSessionIds, ['sess-1', 'sess-1', 'sess-2']);
            assert.equal(created, 2, 'exactly one session recreation for the fresh fallback');
        });
    });
});

test('runWithRecovery: DS generation_err stops immediately with 0 retries configured', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '0', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: a muted body parks the account until mute_until and rotates', async () => {

    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    const muteUntilSec = Math.floor(Date.now() / 1000) + 3600;
    const muted = { message: 'user is muted', muteUntil: muteUntilSec };
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            let first = true;
            const ctx = baseCtx({

                askDSStream: async (args) => {
                    const session = sessions.getOrCreateAgentSession(args.agentId);
                    const acct = first ? a1 : a2;
                    session.accountId = acct.id;
                    first = false;
                    return { resp: { body: {} }, account: acct, promptUsed: args?.prompt || 'p', freshSessionReset: false };
                },

                readDSResponse: sseOnce([
                    { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null, muted },
                    { content: 'after rotation', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'after rotation');

            const remaining = a1.cooldownUntil - Date.now();
            assert.ok(remaining > 3500 * 1000, `expected ~1h park, got ${remaining}ms`);
            assert.equal(a1.failures, 1);
        });
    });
});

test('runWithRecovery: a muted body on all accounts returns 429 with mute_until', async () => {
    const a1 = makeAccount('a1');
    const muteUntilSec = Math.floor(Date.now() / 1000) + 3600;
    const muted = { message: 'user is muted', muteUntil: muteUntilSec };
    await withAccounts([a1], async () => {
        const ctx = baseCtx({
            askDSStream: async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                session.accountId = a1.id;
                session.id = 'sess-muted';
                session.messageCount = 3;
                return { resp: { body: {} }, account: a1, promptUsed: args?.prompt || 'p', freshSessionReset: false };
            },
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null, muted }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
        assert.equal(out.error.body.mute_until, muteUntilSec);

        assert.equal(out.error.body.failed_session_id, 'sess-muted');
        assert.equal(out.error.body.message_count, 3);
        assert.equal(out.error.body.account, a1.id);

        assert.equal(out.error.body.message, 'All auth accounts are muted or cooling down. Retry later.');
    });
});

test('runWithRecovery: empty response on all accounts returns 429 terminal error', async () => {

    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const ctx = baseCtx({
            askDSStream: askStub([cooling]),
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
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const ctx = baseCtx({
                askDSStream: askStub([a1, a2]),
                    readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.ok(out.error, 'expected a terminal error body');
            assert.equal(out.error.body.account_attempts, 2);
        });
    });
});

test('runWithRecovery: rotation stops once the rotation budget elapses', async () => {

    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ROTATION_BUDGET_MS: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const ctx = baseCtx({
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

    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '3', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.equal(out.error.body.upstream_retries, 3);
            assert.equal(out.error.body.account, 'a2');
        });
    });
});

test('runWithRecovery: new reasoning before a generation_err resets the upstream-retry counter', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({
            DS_MAX_UPSTREAM_RETRIES: '1',
            DS_MAX_SAME_ACCOUNT_RETRIES: '1',
            DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0',
        }, async () => {
            let created = 0;
            const seenSessionIds = [];
            const accountStub = async (args) => {
                const session = sessions.getOrCreateAgentSession(args.agentId);
                session.accountId = a1.id;
                if (!session.id) session.id = 'sess-' + (++created);
                seenSessionIds.push(session.id);
                return { resp: { body: {} }, account: a1, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            const transient = () => ({
                content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err',
                modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
            });
            const reasoningOnly = () => ({
                content: '', reasoningContent: 'thinking', messageId: 'm2', finishReason: 'generation_err',
                modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
            });
            const results = [transient(), reasoningOnly(), transient(), transient(), transient()];
            let i = 0;
            const ctx = baseCtx({
                askDSStream: accountStub,
                readDSResponse: async () => results[Math.min(i++, results.length - 1)],
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.body.type, 'upstream_unavailable');
            assert.equal(out.error.body.upstream_retries, 1);
            assert.deepEqual(seenSessionIds, ['sess-1', 'sess-1', 'sess-1', 'sess-1', 'sess-2']);
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

test('runWithRecovery: a tool name inside a known call argument does not rotate the account', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const content = '<\uFF5CDSML\uFF5C calls>\n<\uFF5CDSML\uFF5C invoke name="write">\n<\uFF5CDSML\uFF5C parameter name="path" string="true">/tmp/a.html</\uFF5CDSML\uFF5C parameter>\n<\uFF5CDSML\uFF5C parameter name="content" string="true"><html>x</html></\uFF5CDSML\uFF5C parameter>\n</\uFF5CDSML\uFF5C invoke>\n</\uFF5CDSML\uFF5C calls>';
        const calls = [];
        const ctx = baseCtx({
            tools: [
                { type: 'function', function: { name: 'read' } },
                { type: 'function', function: { name: 'write' } },
            ],
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([{ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.toolCall.name, 'write');
        assert.equal(calls.length, 1);
    });
});

test('runWithRecovery: unknown tool re-prompts the same account instead of rotating', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const unknown = '{"tool_call":{"name":"nope","arguments":{}}}';
        const valid = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
        const calls = [];
        const ctx = baseCtx({
            tools: [
                { type: 'function', function: { name: 'read' } },
                { type: 'function', function: { name: 'write' } },
            ],
            askDSStream: askStub([makeAccount('a1')], calls),
            readDSResponse: sseOnce([
                { content: unknown, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                { content: valid, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
            ]),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.toolCall.name, 'read');
        assert.equal(calls.length, 2);
        assert.match(calls[1].prompt, /nope/);
        assert.match(calls[1].prompt, /read, write/);
    });
});

test('runWithRecovery: unknown tool rotates the account after one re-prompt', async () => {
    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    accountsArr.push(a1, a2);
    try {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const unknown = '{"tool_call":{"name":"nope","arguments":{}}}';
            const valid = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
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
                calls.push({ accountId: account.id, prompt: args.prompt });
                return { resp: { body: {} }, account, promptUsed: args.prompt || 'p', freshSessionReset: false };
            };
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: accountStub,
                readDSResponse: sseOnce([
                    { content: unknown, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: unknown, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: valid, reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 3);

            assert.deepEqual(calls.map(c => c.accountId), ['a1', 'a1', 'a2']);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    } finally {
        accountsArr.length = 0;
        accountsArr.push(...saved);
    }
});

test('runWithRecovery: tool_choice required rotates then accepts a call', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                toolChoice: 'required',
                askDSStream: askStub([a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: 'I cannot call a tool.', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"a"}}}', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: a named tool_choice mismatch is a terminal 502', async () => {
    const real = metrics.inc;
    const counted = [];
    metrics.inc = (name) => counted.push(name);
    try {
        await withAccounts([makeAccount('a1')], async () => {
            const call = '{"tool_call":{"name":"write","arguments":{}}}';
            const ctx = baseCtx({
                tools: [
                    { type: 'function', function: { name: 'read' } },
                    { type: 'function', function: { name: 'write' } },
                ],
                toolChoice: { name: 'read' },
                clientGone: () => true,
                askDSStream: askStub([makeAccount('a1')]),
                readDSResponse: async () => ({ content: call, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false);
            assert.equal(out.error.body.type, 'tool_choice_unmet');
            assert.equal(out.error.body.actual_tool, 'write');
            assert.equal(counted.filter(n => n === 'toolChoiceUnmet').length, 1);
        });
    } finally {
        metrics.inc = real;
    }
});

test('runWithRecovery: tool_choice auto does not enforce a call', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            toolChoice: 'auto',
            askDSStream: askStub([makeAccount('a1')]),
            readDSResponse: async () => ({ content: 'plain answer', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, 'plain answer');
        assert.equal(out.toolCall, null);
    });
});

test('runWithRecovery: terminal unknown tool increments the unknownTool metric', async () => {

    const real = metrics.inc;
    const counted = [];
    metrics.inc = (name) => counted.push(name);
    try {
        await withAccounts([makeAccount('a1')], async () => {
            const content = '{"tool_call":{"name":"nope","arguments":{}}}';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],

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

    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const content = '{"tool_call":{"name":"nope","arguments":{}}}';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
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

    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const content = '<tool_call>{"name":"read","arguments":{"path":';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            askDSStream: askStub([cooling]),
            readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);
        assert.equal(out.error.status, 429);
        assert.equal(out.error.body.type, 'rate_limit_error');
    });
});

test('runWithRecovery: prose preceding malformed markup survives the tool-call re-prompt', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const prose = 'Вот что я нашёл: файл лежит в /x.';
            const malformed = '<tool_calls>{"name":"read","arguments":{"path":';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: `${prose}\n\n${malformed}`, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.match(out.fullContent, /Вот что я нашёл/);
            assert.match(out.fullContent, /"name":"read"/);
        });
    });
});

test('runWithRecovery: malformed markup re-prompts the same session before rotating', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const malformed = '<tool_call>{"name":"read","arguments":{"path":';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: malformed, reasoningContent: 'long reasoning', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2);
            assert.match(calls[1].prompt, /malformed tool-call markup/i);
            assert.match(calls[1].prompt, /emit the tool call again/i);
            assert.doesNotMatch(calls[1].prompt, /long reasoning/);
            assert.match(calls[1].freshSessionPrompt, /long reasoning/);
            assert.match(calls[1].freshSessionPrompt, /emit the tool call immediately/i);
        });
    });
});

test('runWithRecovery: identical malformed markup after the re-prompt rotates the account', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const malformed = '<tool_call>{"name":"read","arguments":{"path":';
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1, a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: malformed, reasoningContent: 'long reasoning A', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: malformed, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 3);
            assert.match(calls[1].prompt, /malformed tool-call markup/i);
            assert.match(calls[1].freshSessionPrompt, /long reasoning A/);
            assert.match(calls[1].freshSessionPrompt, /emit the tool call immediately/i);
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: distinct malformed markup is retried up to three times before rotating', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const broken = (n) => `<tool_calls>{"name":"read","arguments":{"path":"/${n}"`;
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1, a1, a1, a1, a2], calls),
                readDSResponse: sseOnce([
                    { content: broken(1), reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: broken(2), reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: broken(3), reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                    { content: broken(4), reasoningContent: '', messageId: 'm4', finishReason: 'stop', modelError: null },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm5', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 5);
            for (const call of calls.slice(1, 4)) assert.match(call.prompt, /malformed tool-call markup/i);
            assert.doesNotMatch(calls[4].prompt, /malformed tool-call markup/i);
        });
    });
});

test('runWithRecovery: the broken-markup retry budget resets after rotating to a new account', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const broken = (n) => `<tool_calls>{"name":"read","arguments":{"path":"/${n}"`;
            const ctx = baseCtx({
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1, a1, a1, a1, a2, a2, a2, a2], calls),
                readDSResponse: sseOnce([
                    { content: broken(1), reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: broken(2), reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: broken(3), reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                    { content: broken(4), reasoningContent: '', messageId: 'm4', finishReason: 'stop', modelError: null },
                    { content: broken(5), reasoningContent: '', messageId: 'm5', finishReason: 'stop', modelError: null },
                    { content: broken(6), reasoningContent: '', messageId: 'm6', finishReason: 'stop', modelError: null },
                    { content: broken(7), reasoningContent: '', messageId: 'm7', finishReason: 'stop', modelError: null },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm8', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 8);
            assert.equal(calls.filter(c => /malformed tool-call markup/i.test(c.prompt)).length, 6);
        });
    });
});

test('runWithRecovery: prose quoting DSML tags in inline code is delivered, not rotated', async () => {
    const a1 = makeAccount('a1');
    await withConfig({ DS_COMPLETION_CHECK: '0' }, async () => await withAccounts([a1], async () => {
        const calls = [];
        const content = 'Вызовы оборачиваются в `<tool_calls>` с тегами `<invoke>` / `<parameter>`.';
        const ctx = baseCtx({
            tools: [{ type: 'function', function: { name: 'read' } }],
            askDSStream: askStub([a1], calls),
            readDSResponse: async () => ({ content, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, content);
        assert.equal(calls.length, 1);
    }));
});

test('runWithRecovery: auth_expired rotates to the next account and succeeds', async () => {

    const accountsArr = accounts.getAccounts();
    const saved = accountsArr.slice();
    accountsArr.length = 0;
    accountsArr.push(makeAccount('a1'), makeAccount('a2'));
    try {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.deepEqual(calls.map(c => c.accountId), ['a1', 'a2']);

            const a1 = accountsArr.find(a => a.id === 'a1');
            assert.equal(a1.authExpired, true, 'a1 should be disabled after the auth error');
            assert.equal(a1.cooldownUntil, 0, 'auth expiry must not create a cooldown');
        });
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

            askDSStream: accountStub,
            readDSResponse: async () => ({ content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }),
        });
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, false);

        assert.equal(out.error.status, 401);
        assert.equal(out.error.body.type, 'auth_expired');
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
                gone = true;
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

    const cooling = makeAccount('a1', { cooldownUntil: Date.now() + 60000 });
    await withAccounts([cooling], async () => {
        const ctx = baseCtx({
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

    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const ctx = baseCtx({
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

test('backoffDelay: doubles on every consecutive retry', () => {
    const { backoffDelay } = require('../lib/recovery');
    assert.equal(backoffDelay(1, 100), 100);
    assert.equal(backoffDelay(2, 100), 200);
    assert.equal(backoffDelay(3, 100), 400);
    assert.equal(backoffDelay(4, 100), 800);
    assert.equal(backoffDelay(0, 100), 100);
});

test('runWithRecovery: a reasoning-only continuation error keeps the streamed reasoning', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: async (args) => {
                    calls.push(args);
                    if (calls.length === 2) throw new Error('continuation boom');
                    return {
                        resp: { body: {} }, account: a1,
                        promptUsed: args.prompt || 'p', freshSessionReset: false,
                    };
                },
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, '');
            assert.equal(out.reasoningContent, 'thinking hard');
            assert.equal(calls.length, 2);
            assert.equal(calls[1].prompt, 'continue');
            assert.equal(a1.cooldownUntil, 0);
        });
    });
});

test('runWithRecovery: several reasoning-only blocks are streamed before the final answer', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                    { content: '', reasoningContent: 'still thinking', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: 'Final answer.', reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'Final answer.');
            assert.equal(calls.length, 3);
            assert.equal(calls[1].prompt, 'continue');
            assert.equal(calls[2].prompt, 'continue');
            assert.equal(a1.cooldownUntil, 0);
            assert.equal(a1.failures, 0);
        });
    });
});

test('runWithRecovery: continues reasoning-only turns until the reasoning stops growing', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        const calls = [];
        const ctx = baseCtx({
            askDSStream: askStub([a1], calls),
            readDSResponse: sseOnce([
                { content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'stop', modelError: null },
                { content: '', reasoningContent: 'still thinking', messageId: 'm2', finishReason: 'stop', modelError: null },
                { content: '', reasoningContent: 'thinking forever', messageId: 'm3', finishReason: 'stop', modelError: null },
            ]),
        });
        ctx.session.accountId = a1.id;
        const out = await runWithRecovery(ctx);
        assert.equal(out.ok, true);
        assert.equal(out.fullContent, '');
        assert.equal(out.reasoningContent, 'thinking hard\nstill thinking\nthinking forever');
        assert.equal(calls.length, 4, 'the last empty continuation stops the loop');
        assert.equal(a1.cooldownUntil, 0);
    });
});

test('runWithRecovery: clientGone stops reasoning-only recovery', async () => {
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
        assert.equal(out.clientGone, true);
        assert.equal(a1.cooldownUntil, 0);
    });
});

const config = require('../lib/config');

async function withConfig(overrides, fn) {
    config.reload(overrides);
    try {
        return await fn();
    } finally {

        config.reload();
    }
}

test('runWithRecovery: transient outage after reasoning continues instead of resending the prompt', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({
            DS_MAX_UPSTREAM_RETRIES: '3',
            DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0',
        }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    {
                        content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'generation_err',
                        modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
                    },
                    { content: 'the answer', reasoningContent: 'thinking again', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'the answer');
            assert.equal(calls.length, 2);
            assert.equal(calls[1].prompt, 'continue');
        });
    });
});

test('runWithRecovery: transient outage after reasoning falls back to the same-session retry when continuation is empty', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({
            DS_MAX_UPSTREAM_RETRIES: '3',
            DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0',
        }, async () => {
            const calls = [];
            const transient = () => ({
                content: '', reasoningContent: 'thinking hard', messageId: 'm1', finishReason: 'generation_err',
                modelError: { type: 'error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' },
            });
            const ctx = baseCtx({
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    transient(),
                    transient(),
                    { content: 'recovered', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'recovered');
            assert.equal(calls.length, 3);
            assert.equal(calls[1].prompt, 'continue');
            assert.equal(calls[2].prompt, 'SYS\n\nUser: hi');
        });
    });
});

test('runWithRecovery: auto-continuation appends the continuation and updates finishReason', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_CONTINUATION: '2', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

            assert.equal(calls.length, 2);
            assert.equal(calls[1].prompt, 'continue');
        });
    });
});

test('runWithRecovery: rotation re-uploads attachments and the continuation uses the new ids', async () => {
    const a1 = makeAccount('a1');
    const a2 = makeAccount('a2');
    await withAccounts([a1, a2], async () => {
        await withConfig({ DS_MAX_CONTINUATION: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                fileIds: ['f1'],
                fileIdsAccountId: 'a1',
                resolveFileIds: async () => ['f2'],
                askDSStream: async (args) => {
                    calls.push(args);
                    const first = calls.length === 1;
                    return {
                        resp: { body: {} }, account: first ? a1 : a2,
                        promptUsed: args.prompt, freshSessionReset: false,
                        fileIds: first ? ['f1'] : ['f2'],
                        fileIdsAccountId: first ? 'a1' : 'a2',
                    };
                },
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null },
                    { content: 'part1', reasoningContent: '', messageId: 'm1', finishReason: 'length', modelError: null },
                    { content: 'part2', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            ctx.session.accountId = a1.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'part1\npart2');
            assert.equal(calls.length, 3);

            assert.deepEqual(calls[1].fileIds, ['f1']);
            assert.equal(calls[1].fileIdsAccountId, 'a1');
            assert.deepEqual(calls[2].fileIds, ['f2']);
            assert.equal(calls[2].fileIdsAccountId, 'a2');
        });
    });
});

test('runWithRecovery: a refusal continuation is not appended', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_CONTINUATION: '2', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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
        await withConfig({ DS_MAX_CONTINUATION: '2', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            let call = 0;
            const ctx = baseCtx({
                askDSStream: async (args) => {
                    call++;

                    const account = call === 1 ? makeAccount('a1') : makeAccount('a2');
                    return { resp: { body: {} }, account, promptUsed: args.prompt, freshSessionReset: false };
                },
                readDSResponse: sseOnce([
                    { content: 'part1', reasoningContent: '', messageId: 'm1', finishReason: 'length', modelError: null },
                ]),
            });

            ctx.session.accountId = 'a1';
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, 'part1');
        });
    });
});

test('runWithRecovery: MEDIA paths from tool results are injected when absent', async () => {
    await withAccounts([makeAccount('a1')], async () => {

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

        const accountStub = async (args) => {
            const s = sessions.getOrCreateAgentSession(args.agentId);
            calls.push({ prompt: args.prompt });
            if (!s.id) { s.id = 'sess-1'; s.messageCount = 0; }
            return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args.prompt || 'p', freshSessionReset: false };
        };
        let reads = 0;

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

        await runWithRecovery(ctx);
        calls.length = 0;

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

    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_MAX_UPSTREAM_RETRIES: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: '', messageId: 'm1', finishReason: 'generation_err', modelError: { type: 'server_error', content: 'Сервер временно недоступен.', finish_reason: 'generation_err' } },
                    { content: 'ok', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });

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

test('runWithRecovery: short real answer is returned as-is (no re-prompt)', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '0' }, async () => await withAccounts([makeAccount('a1')], async () => {
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
    }));
});

test('runWithRecovery: rate-limit empty response cools the account via the Retry-After path', async () => {

    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {

        const ctx = baseCtx({
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
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

        assert.equal(a1.cooldownUntil, 0);
    });
});

test('runWithRecovery: a generation_err abort after reasoning re-prompts the same session for the tool call', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                thinkingEnabled: true,
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: null, finishReason: null, modelError: { type: 'error', content: 'generation_err', finish_reason: 'generation_err' } },
                    { content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}', reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
                ]),
            });
            const sessionIdBefore = ctx.session.id;
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.toolCall, 'the tool call must be recovered');
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 2, 'one original call plus one re-prompt');
            assert.equal(calls[1].thinkingEnabled, true, 'thinking stays enabled');
            assert.equal(sessionIdBefore, null, 'the first attempt had no remote session yet');
            assert.equal(calls[1].freshSessionReset || false, false, 'the re-prompt does not reset the session');
            assert.match(calls[1].prompt, /emit the tool call now/i, 'the re-prompt asks for the tool call');
            assert.equal(a1.cooldownUntil, 0);
        });
    });
});

test('runWithRecovery: a re-prompt that yields nothing falls through to the normal recovery', async () => {
    const a1 = makeAccount('a1');
    await withAccounts([a1], async () => {
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0', DS_MAX_UPSTREAM_RETRIES: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                thinkingEnabled: true,
                tools: [{ type: 'function', function: { name: 'read' } }],
                askDSStream: askStub([a1], calls),
                readDSResponse: sseOnce([
                    { content: '', reasoningContent: 'thinking hard', messageId: null, finishReason: null, modelError: { type: 'error', content: 'generation_err', finish_reason: 'generation_err' } },
                    { content: '', reasoningContent: 'still thinking', messageId: null, finishReason: null, modelError: { type: 'error', content: 'generation_err', finish_reason: 'generation_err' } },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, false, 'nothing was recovered');
            assert.ok(calls.length >= 2, 'the re-prompt is attempted');
        });
    });
});

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
        await withConfig({ DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
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

        assert.equal(a1.cooldownUntil, 0);
    });
});
