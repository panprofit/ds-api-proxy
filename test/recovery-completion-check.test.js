'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseVerdict, shouldCheckCompletion, runCompletionCheck } = require('../lib/recovery-completion-check');
const { runWithRecovery } = require('../lib/recovery');
const accounts = require('../lib/accounts');
const sessions = require('../lib/sessions');
const config = require('../lib/config');

async function withConfig(overrides, fn) {
    config.reload(overrides);
    try {
        return await fn();
    } finally {
        config.reload();
    }
}

function makeAccount(id) {
    return {
        id,
        file: `/tmp/${id}.json`,
        config: { token: 't', cookie: 'c' },
        headers: {},
        cooldownUntil: 0,
        failures: 0,
        lastUsedAt: 0,
    };
}

async function withAccounts(list, fn) {
    const arr = accounts.getAccounts();
    const saved = arr.slice();
    arr.length = 0;
    arr.push(...list);
    try {
        return await fn();
    } finally {
        arr.length = 0;
        arr.push(...saved);
    }
}

function resetSessions() {
    for (const key of [...sessions.getSessions().keys()]) sessions.getSessions().delete(key);
}

function sseOnce(results, fallback = { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null }) {
    let i = 0;
    return async () => (i < results.length ? results[i++] : fallback);
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
    const session = sessions.getOrCreateAgentSession('completion-check-agent');
    const ctl = { accountAttempt: 0 };
    return {
        agentId: 'completion-check-agent',
        agentTag: '[test]',
        session,
        messages: [],
        prompt: 'do the thing',
        systemPrompt: 'you are helpful',
        tools: [{ type: 'function', function: { name: 'read' } }],
        thinkingEnabled: false,
        searchEnabled: false,
        stop: null,
        toolChoice: null,
        clientGone: () => false,
        rotationDeadlineHit: () => false,
        log: () => {},
        ctl,
        ...overrides,
    };
}

const SHORT = { content: 'Let me check the tests.', reasoningContent: 'I should look.', messageId: 'm1', finishReason: 'stop', modelError: null };

test('parseVerdict: recognises DONE and CONTINUE only', () => {
    assert.equal(parseVerdict('DONE'), 'DONE');
    assert.equal(parseVerdict(' done. '), 'DONE');
    assert.equal(parseVerdict('CONTINUE'), 'CONTINUE');
    assert.equal(parseVerdict('continue now'), 'CONTINUE');
    assert.equal(parseVerdict('maybe'), null);
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict(null), null);
});

test('shouldCheckCompletion: false while the feature is off', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '0' }, async () => {
        const state = { allowedToolNames: new Set(['read']), toolCall: null, modelError: null, finishReason: 'stop', fullContent: 'hi', completionChecked: false };
        assert.equal(shouldCheckCompletion(state), false);
    });
});

test('runWithRecovery: a final short answer is kept and the model is asked once', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    SHORT,
                    { content: 'DONE', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, SHORT.content);
            assert.equal(out.toolCall, null);
            assert.equal(calls.length, 2, 'one original call plus one classification call');
        });
    });
});

test('runWithRecovery: CONTINUE nudges the model into the tool call', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const toolJson = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    SHORT,
                    { content: 'CONTINUE', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: toolJson, reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.ok(out.toolCall, 'the promised action must become a real tool call');
            assert.equal(out.toolCall.name, 'read');
            assert.equal(calls.length, 3);
        });
    });
});

test('runWithRecovery: an unparsable verdict fails open', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    SHORT,
                    { content: 'hmm, hard to say', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, SHORT.content);
            assert.equal(out.toolCall, null);
            assert.equal(calls.length, 2);
        });
    });
});

test('runWithRecovery: CONTINUE with no usable tool call keeps the original answer', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    SHORT,
                    { content: 'CONTINUE', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                    { content: 'I would read the file next.', reasoningContent: '', messageId: 'm3', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, SHORT.content);
            assert.equal(out.toolCall, null);
        });
    });
});

test('runWithRecovery: a long answer is not checked', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_COMPLETION_CHECK_MAX_CHARS: '50', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            const long = 'Let me walk through everything. '.repeat(10);
            const ctx = baseCtx({
                askDSStream: askStub([makeAccount('a1')], calls),
                readDSResponse: sseOnce([
                    { content: long, reasoningContent: 'r', messageId: 'm1', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(calls.length, 1, 'no classification call for a long answer');
        });
    });
});

function checkState(overrides = {}) {
    return {
        completionChecked: false,
        allowedToolNames: new Set(['read']),
        toolCall: null,
        modelError: null,
        finishReason: 'stop',
        fullContent: 'Let me check.',
        freshPrompt: 'do it',
        fileIds: ['f1'],
        fileIdsAccountId: 'a1',
        ...overrides,
    };
}

function checkDeps(overrides = {}) {
    return {
        agentId: 'completion-check-agent',
        agentTag: '[test]',
        session: { accountId: 'a1' },
        resolveFileIds: null,
        thinkingEnabled: false,
        searchEnabled: false,
        abortSignal: null,
        clientGone: () => false,
        log: () => {},
        askDSStream: async () => ({ resp: { body: {} } }),
        readDSResponse: async () => ({ content: 'DONE' }),
        ...overrides,
    };
}

test('shouldCheckCompletion: guards every disqualifying state', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_COMPLETION_CHECK_MAX_CHARS: '50', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        assert.equal(shouldCheckCompletion(checkState()), true);
        assert.equal(shouldCheckCompletion(checkState({ completionChecked: true })), false);
        assert.equal(shouldCheckCompletion(checkState({ allowedToolNames: new Set() })), false);
        assert.equal(shouldCheckCompletion(checkState({ toolCall: { name: 'read' } })), false);
        assert.equal(shouldCheckCompletion(checkState({ modelError: { type: 'x' } })), false);
        assert.equal(shouldCheckCompletion(checkState({ finishReason: 'length' })), false);
        assert.equal(shouldCheckCompletion(checkState({ finishReason: null })), true);
        assert.equal(shouldCheckCompletion(checkState({ fullContent: '   ' })), false);
        assert.equal(shouldCheckCompletion(checkState({ fullContent: 'x'.repeat(51) })), false);
        assert.equal(shouldCheckCompletion(checkState({ fullContent: 'As an AI I cannot continue.' })), false);
        assert.equal(shouldCheckCompletion(checkState({ fullContent: '<tool_result>{"a":1}</tool_result>' })), false);
    });
    await withConfig({ DS_COMPLETION_CHECK: '0' }, async () => {
        assert.equal(shouldCheckCompletion(checkState()), false);
    });
});

test('runCompletionCheck: skips work when the request is already gone', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        let calls = 0;
        const state = checkState();
        const deps = checkDeps({ askDSStream: async () => { calls++; return { resp: { body: {} } }; } });
        assert.equal(await runCompletionCheck(state, checkDeps({ clientGone: () => true, askDSStream: deps.askDSStream })), null);
        assert.equal(calls, 0);
        assert.equal(state.completionChecked, true);
    });
});

test('runCompletionCheck: forwards refreshed file ids from the verdict call', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const state = checkState();
        const deps = checkDeps({
            askDSStream: async () => ({ resp: { body: {} }, fileIds: ['f2'], fileIdsAccountId: 'a2' }),
            readDSResponse: async () => ({ content: 'DONE' }),
        });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.deepEqual(state.fileIds, ['f2']);
        assert.equal(state.fileIdsAccountId, 'a2');
    });
});

test('runCompletionCheck: keeps the old file-id account when the call omits one', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const state = checkState();
        const deps = checkDeps({
            askDSStream: async () => ({ resp: { body: {} }, fileIds: ['f2'] }),
            readDSResponse: async () => ({ content: 'DONE' }),
        });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.deepEqual(state.fileIds, ['f2']);
        assert.equal(state.fileIdsAccountId, 'a1');
    });
});

test('runCompletionCheck: skips the verdict read after account rotation', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const logs = [];
        const state = checkState();
        const deps = checkDeps({
            session: { accountId: 'a1' },
            askDSStream: async () => {
                deps.session.accountId = 'a2';
                return { resp: { body: {} } };
            },
            readDSResponse: async () => { throw new Error('must not read'); },
            log: message => logs.push(message),
        });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.ok(logs.some(message => /rotated account/.test(message)));
    });
});

test('runCompletionCheck: an empty verdict response keeps the answer', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const state = checkState();
        const deps = checkDeps({ readDSResponse: async () => null });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.equal(state.toolCall, null);
    });
});

test('runCompletionCheck: a failing verdict call fails open', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const logs = [];
        const state = checkState();
        const deps = checkDeps({
            askDSStream: async () => { throw new Error('upstream down'); },
            log: message => logs.push(message),
        });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.equal(state.toolCall, null);
        assert.ok(logs.some(message => /completion check failed \(upstream down\)/.test(message)));
    });
});

test('runCompletionCheck: CONTINUE with an empty follow-up keeps the answer', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const responses = [
            { content: 'CONTINUE' },
            null,
        ];
        const state = checkState();
        const deps = checkDeps({ readDSResponse: async () => responses.shift() });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.equal(state.toolCall, null);
    });
});

test('runCompletionCheck: CONTINUE with non-tool text keeps the answer', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const responses = [
            { content: 'CONTINUE' },
            { content: 'I would read the file next.' },
        ];
        const logs = [];
        const state = checkState();
        const deps = checkDeps({ readDSResponse: async () => responses.shift(), log: message => logs.push(message) });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.equal(state.toolCall, null);
        assert.ok(logs.some(message => /no usable tool call/.test(message)));
    });
});

test('runCompletionCheck: CONTINUE with a disallowed tool keeps the answer', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const responses = [
            { content: 'CONTINUE' },
            { content: '{"tool_call":{"name":"write","arguments":{}}}' },
        ];
        const state = checkState();
        const deps = checkDeps({ readDSResponse: async () => responses.shift() });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.equal(state.toolCall, null);
    });
});

test('runCompletionCheck: CONTINUE adopts the follow-up tool call and reasoning', async () => {
    await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
        const responses = [
            { content: 'CONTINUE' },
            {
                content: '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}',
                reasoningContent: 'thinking',
                finishReason: 'tool_calls',
                modelError: 'transient',
            },
        ];
        const state = checkState();
        const deps = checkDeps({ readDSResponse: async () => responses.shift() });
        assert.equal(await runCompletionCheck(state, deps), null);
        assert.equal(state.toolCall.name, 'read');
        assert.equal(state.fullContent, `Let me check.\n\n{"tool_call":{"name":"read","arguments":{"path":"/x"}}}`);
        assert.equal(state.reasoningContent, 'thinking');
        assert.equal(state.finishReason, 'tool_calls');
        assert.equal(state.modelError, 'transient');
    });
});

test('runWithRecovery: a throwing follow-up keeps the original answer instead of failing', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS: '0' }, async () => {
            const calls = [];
            let n = 0;
            const ctx = baseCtx({
                askDSStream: async (args) => {
                    calls.push(args);
                    if (n++ === 1) throw new Error('upstream exploded');
                    return { resp: { body: {} }, account: makeAccount('a1'), promptUsed: args?.prompt || 'p', freshSessionReset: false };
                },
                readDSResponse: sseOnce([
                    SHORT,
                    { content: 'CONTINUE', reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
                ]),
            });
            const out = await runWithRecovery(ctx);
            assert.equal(out.ok, true);
            assert.equal(out.fullContent, SHORT.content);
            assert.equal(calls.length, 2);
        });
    });
});
