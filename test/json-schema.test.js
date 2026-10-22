'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_SCHEMA_DEPTH,
    normalizeStrictSchema,
    normalizeResponseSchema,
    normalizeToolSchema,
    normalizeChatRequestSchemas,
    normalizeResponsesRequestSchemas,
} = require('../lib/json-schema');
const handlers = require('../lib/handlers');
const responses = require('../lib/responses');

function strict(schema, options) {
    return normalizeStrictSchema(schema, options);
}

test('normalizeStrictSchema: fills required and forbids extra properties', () => {
    const result = strict({
        type: 'object',
        properties: {
            city: { type: 'string' },
            days: { type: 'integer' },
        },
    });
    assert.deepEqual(result, {
        ok: true,
        schema: {
            type: 'object',
            properties: {
                city: { type: 'string' },
                days: { type: 'integer' },
            },
            required: ['city', 'days'],
            additionalProperties: false,
        },
    });
});

test('normalizeStrictSchema: normalizes nested objects and arrays', () => {
    const result = strict({
        type: 'object',
        properties: {
            user: {
                type: 'object',
                properties: { name: { type: 'string' } },
            },
            tags: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { id: { type: 'integer' } },
                },
            },
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schema.properties.user.required, ['name']);
    assert.equal(result.schema.properties.user.additionalProperties, false);
    assert.deepEqual(result.schema.properties.tags.items.required, ['id']);
    assert.equal(result.schema.properties.tags.items.additionalProperties, false);
});

test('normalizeStrictSchema: normalizes anyOf variants', () => {
    const result = strict({
        type: 'object',
        properties: {
            value: {
                anyOf: [
                    { type: 'object', properties: { text: { type: 'string' } } },
                    { type: 'string' },
                ],
            },
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schema.properties.value.anyOf[0].required, ['text']);
    assert.equal(result.schema.properties.value.anyOf[0].additionalProperties, false);
});

test('normalizeStrictSchema: preserves $defs so $ref targets stay valid', () => {
    const result = strict({
        type: 'object',
        properties: {
            user: { $ref: '#/$defs/user' },
        },
        $defs: {
            user: {
                type: 'object',
                properties: { name: { type: 'string' } },
            },
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schema.properties.user, { $ref: '#/$defs/user' });
    assert.deepEqual(result.schema.$defs.user.required, ['name']);
    assert.equal(result.schema.$defs.user.additionalProperties, false);
});

test('normalizeStrictSchema: preserves older $def and definitions', () => {
    const result = strict({
        type: 'object',
        properties: {
            a: { $ref: '#/definitions/a' },
            b: { $ref: '#/$def/b' },
        },
        definitions: { a: { type: 'object', properties: { x: { type: 'string' } } } },
        $def: { b: { type: 'object', properties: { y: { type: 'string' } } } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schema.definitions.a.required, ['x']);
    assert.deepEqual(result.schema.$def.b.required, ['y']);
});

test('normalizeStrictSchema: an empty top-level object is allowed only for tools', () => {
    assert.equal(strict({ type: 'object' }, { allowEmptyObject: true }).ok, true);
    const rejected = strict({ type: 'object' });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /no properties/);
});

test('normalizeStrictSchema: empty nested objects are rejected', () => {
    const result = strict({
        type: 'object',
        properties: { inner: { type: 'object' } },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no properties/);
});

test('normalizeStrictSchema: top level must be an object', () => {
    for (const schema of [{ type: 'string' }, { $ref: '#/$defs/x' }, null, [], true]) {
        const result = strict(schema);
        assert.equal(result.ok, false, JSON.stringify(schema));
        assert.match(result.error, /top level/i);
    }
});

test('normalizeStrictSchema: rejects inconsistent required lists', () => {
    const base = { type: 'object', properties: { a: { type: 'string' } } };

    let result = strict({ ...base, required: ['b'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /Required property 'b'/);

    result = strict({ ...base, required: ['a', 'a'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /Duplicate required property 'a'/);

    result = strict({ ...base, required: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /must match all properties/);
});

test('normalizeStrictSchema: rejects additionalProperties true and schemas', () => {
    const base = { type: 'object', properties: { a: { type: 'string' } } };
    let result = strict({ ...base, additionalProperties: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /additionalProperties should not be true/);

    result = strict({ ...base, additionalProperties: { type: 'string' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /additionalProperties must be false/);
});

test('normalizeStrictSchema: rejects deeply nested schemas', () => {
    let schema = { type: 'string' };
    for (let i = 0; i <= MAX_SCHEMA_DEPTH; i++) {
        schema = { type: 'object', properties: { nested: schema } };
    }
    const result = strict(schema);
    assert.equal(result.ok, false);
    assert.match(result.error, /too deeply nested/);
});

test('normalizeToolSchema: a missing schema becomes an empty object schema', () => {
    const result = normalizeToolSchema(undefined, 'noop');
    assert.deepEqual(result, {
        ok: true,
        schema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
        },
    });
});

test('normalizeResponseSchema: empty top-level object is rejected', () => {
    const result = normalizeResponseSchema({ type: 'object' });
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid json schema/);
});

test('normalizeChatRequestSchemas: normalizes strict tools and response schemas', () => {
    const params = {
        tools: [{
            type: 'function',
            function: {
                name: 'lookup',
                strict: true,
                parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
        }],
        functions: [{
            name: 'legacy',
            strict: true,
            parameters: { type: 'object', properties: { n: { type: 'integer' } } },
        }],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'answer',
                strict: true,
                schema: { type: 'object', properties: { text: { type: 'string' } } },
            },
        },
    };
    assert.equal(normalizeChatRequestSchemas(params), null);
    assert.deepEqual(params.tools[0].function.parameters.required, ['q']);
    assert.deepEqual(params.functions[0].parameters.required, ['n']);
    assert.deepEqual(params.response_format.json_schema.schema.required, ['text']);
});

test('normalizeChatRequestSchemas: leaves non-strict schemas untouched', () => {
    const params = {
        tools: [{
            type: 'function',
            function: {
                name: 'lookup',
                strict: false,
                parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
        }],
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'answer', schema: { type: 'object' } },
        },
    };
    assert.equal(normalizeChatRequestSchemas(params), null);
    assert.equal(params.tools[0].function.parameters.required, undefined);
    assert.equal(params.response_format.json_schema.schema.required, undefined);
});

test('normalizeChatRequestSchemas: json_schema requires the schema field', () => {
    assert.equal(normalizeChatRequestSchemas({
        response_format: { type: 'json_schema', json_schema: { name: 'answer' } },
    }), 'Invalid json schema: schema is required');
    assert.equal(normalizeChatRequestSchemas({
        response_format: { type: 'json_schema' },
    }), 'Invalid json schema: json_schema is required');
});

test('normalizeResponsesRequestSchemas: json_schema requires the schema field', () => {
    assert.equal(normalizeResponsesRequestSchemas({
        text: { format: { type: 'json_schema', name: 'answer' } },
    }), 'Invalid json schema: schema is required');
});

test('normalizeChatRequestSchemas: reports strict schema errors with the tool name', () => {
    const error = normalizeChatRequestSchemas({
        tools: [{
            type: 'function',
            function: {
                name: 'broken',
                strict: true,
                parameters: { type: 'object', properties: { inner: { type: 'object' } } },
            },
        }],
    });
    assert.match(error, /Invalid schema for function 'broken'/);
});

test('normalizeResponsesRequestSchemas: normalizes flat tools and text.format', () => {
    const params = {
        tools: [{
            type: 'function',
            name: 'lookup',
            strict: true,
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
        }],
        text: {
            format: {
                type: 'json_schema',
                name: 'answer',
                strict: true,
                schema: { type: 'object', properties: { text: { type: 'string' } } },
            },
        },
    };
    assert.equal(normalizeResponsesRequestSchemas(params), null);
    assert.deepEqual(params.tools[0].parameters.required, ['q']);
    assert.deepEqual(params.text.format.schema.required, ['text']);
});

test('parseChatRequest: rejects an invalid strict schema with 400', () => {
    const parsed = handlers.parseChatRequest(JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{
            type: 'function',
            function: { name: 'broken', strict: true, parameters: { type: 'string' } },
        }],
    }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.status, 400);
    assert.equal(parsed.error.type, 'invalid_request_error');
    assert.match(parsed.error.message, /top level/i);
});

test('parseResponsesRequest: rejects an invalid strict schema with 400', () => {
    const parsed = responses.parseResponsesRequest(JSON.stringify({
        input: 'hi',
        text: {
            format: {
                type: 'json_schema',
                name: 'answer',
                strict: true,
                schema: { type: 'object' },
            },
        },
    }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.status, 400);
    assert.match(parsed.error.message, /Invalid json schema/);
});

test('normalizeStrictSchema: rejects malformed subschema containers', () => {
    const cases = [
        [{ type: 'object', properties: 'nope' }, /properties: expected an object/],
        [{ type: 'object', properties: { x: 1 } }, /properties\.x: expected an object/],
        [{ type: 'object', properties: { x: { anyOf: 'nope' } } }, /properties\.x\.anyOf: expected an array/],
        [{ type: 'object', properties: { x: { anyOf: [1] } } }, /properties\.x\.anyOf\[0\]: expected an object/],
        [{ type: 'object', properties: { x: { oneOf: [1] } } }, /properties\.x\.oneOf\[0\]: expected an object/],
        [{ type: 'object', properties: { x: { not: 1 } } }, /properties\.x\.not: expected an object/],
        [{ type: 'object', properties: { x: { patternProperties: [] } } }, /properties\.x\.patternProperties: expected an object/],
        [{ type: 'object', properties: { x: { patternProperties: { '^a': 1 } } } }, /properties\.x\.patternProperties\.\^a: expected an object/],
        [{ type: 'object', properties: { x: { type: 'array', items: [1] } } }, /properties\.x\.items\[0\]: expected an object/],
        [{ type: 'object', properties: { x: { type: 'array', items: 1 } } }, /properties\.x\.items: expected an object/],
        [{ type: 'object', properties: { x: { type: 'array', prefixItems: {} } } }, /properties\.x\.prefixItems: expected an array/],
        [{ type: 'object', properties: { x: { type: 'array', prefixItems: [1] } } }, /properties\.x\.prefixItems\[0\]: expected an object/],
        [{ type: 'object', $defs: [] }, /\$defs: expected an object/],
        [{ type: 'object', $defs: { a: 1 } }, /\$defs\.a: expected an object/],
        [{ type: 'object', definitions: 'nope' }, /definitions: expected an object/],
        [{ type: 'object', properties: { x: { type: 'object', properties: { y: { $def: [] } } } } }, /properties\.x\.properties\.y\.\$def: expected an object/],
    ];
    for (const [schema, pattern] of cases) {
        const result = strict(schema);
        assert.equal(result.ok, false, JSON.stringify(schema));
        assert.match(result.error, pattern);
    }
});

test('normalizeStrictSchema: rejects malformed required lists', () => {
    const base = { type: 'object', properties: { a: { type: 'string' } } };
    for (const required of ['a', [1]]) {
        const result = strict({ ...base, required });
        assert.equal(result.ok, false);
        assert.match(result.error, /required: expected an array of strings/);
    }
});

test('normalizeStrictSchema: normalizes tuple items and prefixItems', () => {
    const result = strict({
        type: 'object',
        properties: {
            pair: {
                type: 'array',
                items: [
                    { type: 'object', properties: { a: { type: 'string' } } },
                    { type: 'string' },
                ],
                prefixItems: [{ type: 'object', properties: { b: { type: 'string' } } }],
            },
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.schema.properties.pair.items[0].required, ['a']);
    assert.deepEqual(result.schema.properties.pair.prefixItems[0].required, ['b']);
});

test('normalizeStrictSchema: normalizes every subschema keyword', () => {
    const result = strict({
        type: 'object',
        properties: {
            value: {
                anyOf: [{ type: 'string' }],
                oneOf: [{ type: 'string' }],
                allOf: [{ type: 'string' }],
                not: { type: 'string' },
                if: { type: 'object', properties: { a: { type: 'string' } } },
                then: { type: 'object', properties: { b: { type: 'string' } } },
                else: { type: 'object', properties: { c: { type: 'string' } } },
                contains: { type: 'string' },
                propertyNames: { type: 'string' },
                patternProperties: { '^a': { type: 'object', properties: { d: { type: 'string' } } } },
                dependentSchemas: { foo: { type: 'object', properties: { e: { type: 'string' } } } },
            },
        },
    });
    assert.equal(result.ok, true);
    const value = result.schema.properties.value;
    assert.deepEqual(value.if.required, ['a']);
    assert.deepEqual(value.then.required, ['b']);
    assert.deepEqual(value.else.required, ['c']);
    assert.deepEqual(value.patternProperties['^a'].required, ['d']);
    assert.deepEqual(value.dependentSchemas.foo.required, ['e']);
});

test('normalizeChatRequestSchemas: skips non-object tools and names unknown schemas', () => {
    const error = normalizeChatRequestSchemas({
        tools: [1, null, { type: 'function', function: { strict: true, parameters: { type: 'string' } } }],
    });
    assert.match(error, /Invalid schema for function 'unknown'/);
});

test('normalizeChatRequestSchemas: rejects a non-object json_schema container', () => {
    assert.equal(normalizeChatRequestSchemas({
        response_format: { type: 'json_schema', json_schema: [] },
    }), 'Invalid json schema: json_schema is required');
});

test('normalizeChatRequestSchemas: reports an invalid strict response schema', () => {
    assert.match(normalizeChatRequestSchemas({
        response_format: {
            type: 'json_schema',
            json_schema: { strict: true, schema: { type: 'object' } },
        },
    }), /Invalid json schema/);
});

test('normalizeResponsesRequestSchemas: reports an invalid strict response schema', () => {
    assert.match(normalizeResponsesRequestSchemas({
        text: { format: { type: 'json_schema', strict: true, schema: { type: 'object' } } },
    }), /Invalid json schema/);
});

test('normalizeResponsesRequestSchemas: tolerates missing tools and text', () => {
    assert.equal(normalizeResponsesRequestSchemas({}), null);
    assert.equal(normalizeResponsesRequestSchemas({ text: 'nope', tools: 'nope' }), null);
});
