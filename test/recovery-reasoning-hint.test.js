'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithRecovery } = require('../lib/recovery');

const HINT = /do not repeat the reasoning/i;

function makeAccount(id) {
    return { id, token: 't-' + id, cooldownUntil: 0, failures: 0, muted: false, throttleAt: 0 };
}

function baseCtx(overrides) {
    return {
        messages: [{ role: 'user', content: 'read /x' }],
        prompt: 'read /x',
        systemPrompt: '',
        tools: [{ type: 'function', function: { name: 'read' } }],
        thinkingEnabled: false,
        searchEnabled: false,
        agentId: 'agent-1',
        agentTag: '[test]',
        session: { id: 's1', messageCount: 0, accountId: null, parentMessageId: null },
        clientGone: () => false,
        log: () => {},
        ...overrides,
    };
}

function askStub(accounts, calls) {
    let i = 0;
    return async (args) => {
        calls.push(args);
        const account = accounts[Math.min(i, accounts.length - 1)];
        i++;
        return {
            resp: { body: null },
            accountId: account.id,
            parentMessageId: 'm' + i,
            fileIds: null,
            fileIdsAccountId: null,
        };
    };
}

function sseOnce(results) {
    let i = 0;
    return async () => {
        const result = results[Math.min(i, results.length - 1)];
        i++;
        return result;
    };
}

const MALFORMED = '<tool_calls>{"name":"read","arguments":{"path":';
const VALID = '{"tool_call":{"name":"read","arguments":{"path":"/x"}}}';

test('runWithRecovery: broken markup reprompt omits the reasoning hint when thinking is off', async () => {
    const account = makeAccount('a1');
    const calls = [];
    const ctx = baseCtx({
        askDSStream: askStub([account], calls),
        readDSResponse: sseOnce([
            { content: MALFORMED, reasoningContent: '', messageId: 'm1', finishReason: 'stop', modelError: null },
            { content: VALID, reasoningContent: '', messageId: 'm2', finishReason: 'stop', modelError: null },
        ]),
    });
    ctx.session.accountId = account.id;

    const out = await runWithRecovery(ctx);

    assert.equal(out.ok, true);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[1].prompt, HINT);
    assert.doesNotMatch(calls[1].freshSessionPrompt, HINT);
    assert.match(calls[1].prompt, /strict JSON/i);
});
