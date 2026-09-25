'use strict';
// Direct unit tests for lib/recovery-markup.js: markup diagnostics and the two
// recovery passes (completion rounds + one strict retry). These were only
// covered indirectly through recovery.test.js. Dependencies are injected, so
// no network or real upstream session is involved.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');
const sessions = require('../lib/sessions');
const { describeToolMarkup, debugDumpToolMarkup, runMarkupCompletion, runStrictToolRetry } = require('../lib/recovery-markup');

// --- helpers ---------------------------------------------------------------

function withConfig(overrides, fn) {
    const saved = config.get();
    config.reload({ ...process.env, ...overrides });
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            config.reload({
                ...process.env,
                DS_RECOVERY_RETRY_DELAY_MS: String(saved.recoveryRetryDelayMs),
                DS_MAX_MARKUP_COMPLETION: String(saved.maxMarkupCompletion),
            });
        });
}

function resetSessions() {
    for (const key of [...sessions.getSessions().keys()]) sessions.getSessions().delete(key);
}

// Build a state + deps pair for the recovery passes. `readDSResponse` results
// are consumed in order; `askDSStream` records the options object of each call.
function makeCtx({ content, allowed = ['read', 'bash'], responses = [], configOverrides = {} } = {}) {
    resetSessions();
    const session = sessions.getOrCreateAgentSession('agent1');
    session.id = 'sess-1';
    session.accountId = 'a1';
    session.parentMessageId = null;
    const state = {
        fullContent: content,
        reasoningContent: '',
        finishReason: null,
        modelError: null,
        freshPrompt: 'SYS\nUser: hi',
        toolCall: null,
        allowedToolNames: new Set(allowed),
    };
    const calls = [];
    let i = 0;
    const deps = {
        agentId: 'agent1',
        agentTag: '[agent1]',
        session,
        askDSStream: async (args) => { calls.push(args); return { resp: { body: {} }, account: { id: 'a1' } }; },
        readDSResponse: async () => (i < responses.length ? responses[i++] : { content: '', reasoningContent: '', messageId: null, finishReason: 'stop', modelError: null }),
        fileIds: [],
        thinkingEnabled: false,
        clientGone: () => false,
        deadlineHit: () => false,
        log: () => {},
    };
    return { state, deps, calls, session, configOverrides };
}

// --- describeToolMarkup ----------------------------------------------------

test('describeToolMarkup: JSON shape reports the parse error and head/tail', () => {
    const diag = describeToolMarkup('{"tool_call":{"name":"read","arguments":{"p":}}');
    assert.equal(diag.shape, 'json');
    assert.equal(diag.dsmlTags, 'n/a');
    assert.equal(diag.looksLikeMarkup, true);
    assert.ok(diag.parseError && diag.parseError.startsWith('json:'));
    assert.ok(diag.head.length <= 80);
});

test('describeToolMarkup: DSML shape counts structural tags', () => {
    const diag = describeToolMarkup('<tool_calls><invoke name="read"><parameter name="p">1</parameter></invoke></tool_calls>');
    assert.equal(diag.shape, 'dsml');
    assert.equal(diag.dsmlTags, '6');
});

test('describeToolMarkup: an oversized/unbalanced DSML body reports it', () => {
    const diag = describeToolMarkup('<tool_calls><invoke name="read">');
    assert.equal(diag.shape, 'dsml');
    // Unbalanced tags still scan (they are recognized), so the count is numeric
    // or the explicit marker; either way it must not throw.
    assert.ok(typeof diag.dsmlTags === 'string');
});

test('describeToolMarkup: plain prose is not markup', () => {
    const diag = describeToolMarkup('just a normal answer with no call');
    assert.equal(diag.looksLikeMarkup, false);
    assert.equal(diag.parseError, 'no-call');
});

// --- runMarkupCompletion ---------------------------------------------------

test('runMarkupCompletion: appends the completion and parses the tool call', async () => {
    await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        // First stream completes the truncated JSON.
        const { state, deps, calls } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":1',
            responses: [{ content: '}}}', reasoningContent: '', messageId: 'm', finishReason: 'stop', modelError: null }],
        });
        await runMarkupCompletion(state, deps);
        assert.ok(state.toolCall, 'expected the completed markup to parse');
        assert.equal(state.toolCall.name, 'read');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].prompt, 'continue');
    });
});

test('runMarkupCompletion: a completion that restarts the markup is ignored', async () => {
    await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps, calls } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":1',
            responses: [{ content: '```json\n{...}', reasoningContent: '', messageId: 'm', finishReason: 'stop', modelError: null }],
        });
        await runMarkupCompletion(state, deps);
        assert.equal(state.toolCall, null);
        assert.equal(calls.length, 1, 'the restart stops the loop after one round');
    });
});

test('runMarkupCompletion: does nothing when the markup already parses', async () => {
    await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps, calls } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":1}}}',
        });
        state.toolCall = { name: 'read', arguments: '{"p":1}' };
        await runMarkupCompletion(state, deps);
        assert.equal(calls.length, 0);
    });
});

test('runMarkupCompletion: no allowed tools means no completion attempt', async () => {
    await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps, calls } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":1',
            allowed: [],
        });
        await runMarkupCompletion(state, deps);
        assert.equal(calls.length, 0);
    });
});

test('runMarkupCompletion: stops immediately when the client is gone', async () => {
    await withConfig({ DS_MAX_MARKUP_COMPLETION: '2', DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps, calls } = makeCtx({ content: '{"tool_call":{"name":"read","arguments":{"p":1' });
        deps.clientGone = () => true;
        await runMarkupCompletion(state, deps);
        assert.equal(calls.length, 0);
    });
});

// --- runStrictToolRetry ----------------------------------------------------

test('runStrictToolRetry: a clean retry replaces the content and tool call', async () => {
    await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const good = '{"tool_call":{"name":"read","arguments":{"p":9}}}';
        const { state, deps, calls } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":',
            responses: [{ content: good, reasoningContent: '', messageId: 'm', finishReason: 'stop', modelError: null }],
        });
        await runStrictToolRetry(state, deps);
        assert.equal(calls.length, 1);
        assert.ok(state.toolCall, 'expected the strict retry to parse');
        assert.deepEqual(JSON.parse(state.toolCall.arguments), { p: 9 });
        assert.equal(state.fullContent, good);
    });
});

test('runStrictToolRetry: a still-broken retry leaves toolCall null', async () => {
    await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":',
            responses: [{ content: 'still broken {"tool_call":{', reasoningContent: '', messageId: 'm', finishReason: 'stop', modelError: null }],
        });
        await runStrictToolRetry(state, deps);
        assert.equal(state.toolCall, null);
    });
});

test('runStrictToolRetry: does nothing when the markup already parses', async () => {
    await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps, calls } = makeCtx({ content: '{"tool_call":{"name":"read","arguments":{}}}' });
        state.toolCall = { name: 'read', arguments: '{}' };
        await runStrictToolRetry(state, deps);
        assert.equal(calls.length, 0);
    });
});

test('runStrictToolRetry: resets the remote session before retrying', async () => {
    await withConfig({ DS_RECOVERY_RETRY_DELAY_MS: '0' }, async () => {
        const { state, deps, session } = makeCtx({
            content: '{"tool_call":{"name":"read","arguments":{"p":',
            responses: [{ content: '', reasoningContent: '', messageId: null, finishReason: 'stop', modelError: null }],
        });
        await runStrictToolRetry(state, deps);
        // The strict retry must start from a fresh remote session; observe it
        // via the reset's effect (the session id is cleared).
        assert.equal(session.id, null, 'the remote session was reset before the retry');
    });
});

// --- debugDumpToolMarkup ---------------------------------------------------

test('debugDumpToolMarkup: no-op when DS_DEBUG is off', () => {
    const lines = [];
    debugDumpToolMarkup('[a]', 'some content', (m) => lines.push(m));
    assert.equal(lines.length, 0);
});
