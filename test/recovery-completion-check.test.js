'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseVerdict, shouldCheckCompletion } = require('../lib/recovery-completion-check');
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
        deadlineHit: () => false,
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

test('shouldCheckCompletion: false while the feature is off', () => {
    const state = { allowedToolNames: new Set(['read']), toolCall: null, modelError: null, finishReason: 'stop', fullContent: 'hi', completionChecked: false };
    assert.equal(shouldCheckCompletion(state), false);
});

test('runWithRecovery: a final short answer is kept and the model is asked once', async () => {
    await withAccounts([makeAccount('a1')], async () => {
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
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
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
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
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
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
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
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
        await withConfig({ DS_COMPLETION_CHECK: '1', DS_COMPLETION_CHECK_MAX_CHARS: '50', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
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
