'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const handlers = require('../lib/handlers');
const reasoning = require('../lib/reasoning');
const prompt = require('../lib/prompt');
const parser = require('../lib/parser');
const { normalizeStrictSchema } = require('../lib/json-schema');
const fixture = require('./fixtures/recipe-conformance');

for (const entry of fixture.thinking) {
    test(`recipe thinking: ${entry.name}`, () => {
        assert.equal(handlers.resolveThinkingEnabled(entry.params), entry.enabled);
    });
}

for (const entry of fixture.responsesThinking) {
    test(`recipe responses thinking: ${entry.name}`, () => {
        assert.equal(reasoning.resolveResponsesThinkingEnabled(entry.params), entry.enabled);
    });
}

for (const entry of fixture.responseFormats) {
    test(`recipe response format: ${entry.name}`, () => {
        assert.equal(prompt.formatResponseFormat(entry.format), entry.expected);
    });
}

for (const entry of fixture.strictSchemas) {
    test(`recipe strict schema: ${entry.name}`, () => {
        const result = normalizeStrictSchema(entry.schema);
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.schema, entry.expected);
    });
}

for (const entry of fixture.invalidStrictSchemas) {
    test(`recipe strict schema rejects: ${entry.name}`, () => {
        const result = normalizeStrictSchema(entry.schema);
        assert.equal(result.ok, false);
        assert.match(result.error, new RegExp(entry.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
}

for (const entry of fixture.dsml) {
    test(`recipe DSML: ${entry.name}`, () => {
        const call = parser.parseToolCall(entry.text, () => {});
        assert.ok(call, 'expected a parsed tool call');
        assert.equal(call.name, entry.call.name);
        assert.deepEqual(JSON.parse(call.arguments), entry.call.args);
    });
}
