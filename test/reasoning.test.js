'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reasoning = require('../lib/reasoning');
const responses = require('../lib/responses');

test('resolveThinkingEnabled: absent settings keep thinking off', () => {
    assert.equal(reasoning.resolveThinkingEnabled({}), false);
    assert.equal(reasoning.resolveThinkingEnabled({ reasoning_effort: null }), false);
    assert.equal(reasoning.resolveThinkingEnabled({ thinking: null }), false);
});

test('resolveThinkingEnabled: none disables and every other effort enables', () => {
    assert.equal(reasoning.resolveThinkingEnabled({ reasoning_effort: 'none' }), false);
    for (const effort of reasoning.ENABLING_EFFORTS) {
        assert.equal(reasoning.resolveThinkingEnabled({ reasoning_effort: effort }), true, effort);
    }
});

test('resolveThinkingEnabled: thinking wins over reasoning_effort', () => {
    assert.equal(reasoning.resolveThinkingEnabled({
        thinking: { type: 'disabled' },
        reasoning_effort: 'max',
    }), false);
    assert.equal(reasoning.resolveThinkingEnabled({
        thinking: { type: 'enabled' },
        reasoning_effort: 'none',
    }), true);
});

test('resolveResponsesThinkingEnabled: nested reasoning.effort is honoured', () => {
    assert.equal(reasoning.resolveResponsesThinkingEnabled({ reasoning: { effort: 'none' } }), false);
    assert.equal(reasoning.resolveResponsesThinkingEnabled({ reasoning: { effort: 'high' } }), true);
    assert.equal(reasoning.resolveResponsesThinkingEnabled({ reasoning: {} }), false);
    assert.equal(reasoning.resolveResponsesThinkingEnabled({ reasoning: null }), false);
});

test('resolveResponsesThinkingEnabled: top-level reasoning_effort is a fallback', () => {
    assert.equal(reasoning.resolveResponsesThinkingEnabled({ reasoning_effort: 'none' }), false);
    assert.equal(reasoning.resolveResponsesThinkingEnabled({ reasoning_effort: 'low' }), true);
    assert.equal(reasoning.resolveResponsesThinkingEnabled({
        reasoning: { effort: 'none' },
        reasoning_effort: 'max',
    }), false);
});

test('resolveReasoningEffortScore: maps effort levels to the V4.1 scores', () => {
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'none' }), null);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'minimal' }), 50);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'low' }), 50);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'medium' }), 75);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'high' }), 75);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'xhigh' }), 75);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'ultra' }), 100);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'max' }), 100);
});

test('resolveReasoningEffortScore: explicit thinking wins and defaults to high', () => {
    assert.equal(reasoning.resolveReasoningEffortScore({ thinking: { type: 'disabled' }, reasoning_effort: 'max' }), null);
    assert.equal(reasoning.resolveReasoningEffortScore({ thinking: { type: 'enabled' } }), 75);
    assert.equal(reasoning.resolveReasoningEffortScore({ thinking: { type: 'adaptive' } }), 75);
    assert.equal(reasoning.resolveReasoningEffortScore({ thinking: { type: 'enabled' }, reasoning_effort: 'none' }), 75);
});

test('resolveReasoningEffortScore: Responses reads reasoning.effort first', () => {
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning: { effort: 'none' } }, { responses: true }), null);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning: { effort: 'max' } }, { responses: true }), 100);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning_effort: 'low' }, { responses: true }), 50);
    assert.equal(reasoning.resolveReasoningEffortScore({ reasoning: { effort: 'none' }, reasoning_effort: 'max' }, { responses: true }), null);
});

test('validateThinkingParams: accepts the documented values', () => {
    assert.equal(reasoning.validateThinkingParams({ reasoning_effort: 'max' }), null);
    assert.equal(reasoning.validateThinkingParams({ thinking: { type: 'adaptive' } }), null);
    assert.equal(reasoning.validateThinkingParams({ reasoning: { effort: 'minimal' } }, { responses: true }), null);
});

test('validateThinkingParams: rejects malformed values', () => {
    assert.match(reasoning.validateThinkingParams({ reasoning_effort: 'fast' }), /reasoning_effort/);
    assert.match(reasoning.validateThinkingParams({ thinking: { type: 'auto' } }), /thinking/);
    assert.match(reasoning.validateThinkingParams({ thinking: { type: 'auto' } }, { responses: true }), /thinking/);
    assert.match(reasoning.validateThinkingParams({ reasoning: 'high' }, { responses: true }), /reasoning/);
    assert.match(reasoning.validateThinkingParams({ reasoning: { effort: 'ultra-fast' } }, { responses: true }), /reasoning\.effort/);
});

test('Responses parsing rejects invalid reasoning but keeps none disabled', () => {
    assert.equal(responses.parseResponsesRequest(JSON.stringify({
        input: 'hi',
        reasoning: { effort: 'none' },
    })).ok, true);
    assert.equal(responses.toInternalParams({ input: 'hi', reasoning: { effort: 'none' } }).thinkingEnabled, false);

    const parsed = responses.parseResponsesRequest(JSON.stringify({
        input: 'hi',
        reasoning: { effort: 'turbo' },
    }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.status, 400);
});
