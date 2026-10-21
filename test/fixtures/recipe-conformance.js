'use strict';
// Behavioral fixtures derived from deepseek-recipe 0.2.0 (MIT).
//
// They pin the protocol semantics ds-api-proxy mirrors. The tests load these
// cases directly; no Rust code or model weights are involved.

// Chat Completions resolution: `thinking` > reasoning_effort > default off.
const thinking = [
    { name: 'default-off', params: {}, enabled: false },
    { name: 'effort-none', params: { reasoning_effort: 'none' }, enabled: false },
    { name: 'effort-null', params: { reasoning_effort: null }, enabled: false },
    { name: 'effort-minimal', params: { reasoning_effort: 'minimal' }, enabled: true },
    { name: 'effort-low', params: { reasoning_effort: 'low' }, enabled: true },
    { name: 'effort-medium', params: { reasoning_effort: 'medium' }, enabled: true },
    { name: 'effort-high', params: { reasoning_effort: 'high' }, enabled: true },
    { name: 'effort-xhigh', params: { reasoning_effort: 'xhigh' }, enabled: true },
    { name: 'effort-ultra', params: { reasoning_effort: 'ultra' }, enabled: true },
    { name: 'effort-max', params: { reasoning_effort: 'max' }, enabled: true },
    { name: 'thinking-enabled', params: { thinking: { type: 'enabled' } }, enabled: true },
    { name: 'thinking-adaptive', params: { thinking: { type: 'adaptive' } }, enabled: true },
    { name: 'thinking-disabled-wins', params: { thinking: { type: 'disabled' }, reasoning_effort: 'max' }, enabled: false },
    { name: 'thinking-enabled-wins', params: { thinking: { type: 'enabled' }, reasoning_effort: 'none' }, enabled: true },
];

// Responses resolution: reasoning.effort > top-level reasoning_effort > default.
const responsesThinking = [
    { name: 'default-off', params: {}, enabled: false },
    { name: 'nested-none', params: { reasoning: { effort: 'none' } }, enabled: false },
    { name: 'nested-high', params: { reasoning: { effort: 'high' } }, enabled: true },
    { name: 'nested-without-effort', params: { reasoning: {} }, enabled: false },
    { name: 'top-level-none', params: { reasoning_effort: 'none' }, enabled: false },
    { name: 'top-level-low', params: { reasoning_effort: 'low' }, enabled: true },
    { name: 'nested-none-wins', params: { reasoning: { effort: 'none' }, reasoning_effort: 'max' }, enabled: false },
];

// Numeric effort scores from the V4.1 template (low=50, high/xhigh=75,
// max=100); enabled thinking without an effort defaults to high.
const effortScores = [
    { name: 'none', params: { reasoning_effort: 'none' }, score: null },
    { name: 'minimal', params: { reasoning_effort: 'minimal' }, score: 50 },
    { name: 'low', params: { reasoning_effort: 'low' }, score: 50 },
    { name: 'medium', params: { reasoning_effort: 'medium' }, score: 75 },
    { name: 'high', params: { reasoning_effort: 'high' }, score: 75 },
    { name: 'xhigh', params: { reasoning_effort: 'xhigh' }, score: 75 },
    { name: 'ultra', params: { reasoning_effort: 'ultra' }, score: 100 },
    { name: 'max', params: { reasoning_effort: 'max' }, score: 100 },
    { name: 'thinking-default-high', params: { thinking: { type: 'enabled' } }, score: 75 },
    { name: 'thinking-disabled', params: { thinking: { type: 'disabled' }, reasoning_effort: 'max' }, score: null },
];

// Strict schema normalization: required lists every property, additional
// properties are forbidden, and $defs survive so $ref stays resolvable.
const strictSchemas = [
    {
        name: 'flat-object',
        schema: { type: 'object', properties: { city: { type: 'string' } } },
        expected: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
        },
    },
    {
        name: 'nested-object',
        schema: {
            type: 'object',
            properties: {
                inner: { type: 'object', properties: { x: { type: 'integer' } } },
            },
        },
        expected: {
            type: 'object',
            properties: {
                inner: {
                    type: 'object',
                    properties: { x: { type: 'integer' } },
                    required: ['x'],
                    additionalProperties: false,
                },
            },
            required: ['inner'],
            additionalProperties: false,
        },
    },
    {
        name: 'defs-preserved',
        schema: {
            type: 'object',
            properties: { user: { $ref: '#/$defs/user' } },
            $defs: {
                user: { type: 'object', properties: { name: { type: 'string' } } },
            },
        },
        expected: {
            type: 'object',
            properties: { user: { $ref: '#/$defs/user' } },
            required: ['user'],
            additionalProperties: false,
            $defs: {
                user: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name'],
                    additionalProperties: false,
                },
            },
        },
    },
];

const invalidStrictSchemas = [
    { name: 'empty-nested-object', schema: { type: 'object', properties: { inner: { type: 'object' } } }, error: 'no properties' },
    { name: 'non-object-top-level', schema: { type: 'string' }, error: 'top level' },
    { name: 'additional-properties-true', schema: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: true }, error: 'additionalProperties' },
    { name: 'unknown-required', schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['y'] }, error: "Required property 'y'" },
];

// V4.1 response-format block for structured output.
const responseFormats = [
    {
        name: 'json-object',
        format: { type: 'json_object' },
        expected: '## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n{"type": "json_object"}',
    },
    {
        name: 'json-schema',
        format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
        expected: '## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n{"type":"object"}',
    },
];

// DSML spellings from the V4.1 template. V4.1 writes a leading space before
// the tag name; the parser also accepts the older spelling without it.
const D = '\uFF5CDSML\uFF5C';

const dsml = [
    {
        name: 'v41-leading-space',
        text: `<${D} calls>\n<${D} invoke name="get_weather">\n<${D} parameter name="city" string="true">Moscow</${D} parameter>\n</${D} invoke>\n</${D} calls>`,
        call: { name: 'get_weather', args: { city: 'Moscow' } },
    },
    {
        name: 'legacy-no-space',
        text: `<${D}tool_calls>\n<${D}invoke name="lookup">\n<${D}parameter name="q" string="true">x</${D}parameter>\n</${D}invoke>\n</${D}tool_calls>`,
        call: { name: 'lookup', args: { q: 'x' } },
    },
];

module.exports = {
    thinking,
    responsesThinking,
    effortScores,
    responseFormats,
    strictSchemas,
    invalidStrictSchemas,
    dsml,
};
