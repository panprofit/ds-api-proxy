'use strict';
// Strict JSON Schema normalization for structured output and strict tools.
//
// The rules mirror DeepSeek's strict-mode conversion: every object lists all
// of its properties in `required` and forbids additional properties, and an
// object without properties is rejected outside the top level of a tool
// schema. Unlike the Rust reference, `$defs`/`definitions` are preserved so a
// `$ref` never points at a definition this pass removed.

const MAX_SCHEMA_DEPTH = 64;

const EMPTY_OBJECT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
});

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(error) {
    return { ok: false, error };
}

function ok(schema) {
    return { ok: true, schema };
}

function normalizeSubschemas(map, path, depth) {
    if (!isPlainObject(map)) return fail(`${path}: expected an object`);
    const out = {};
    for (const [key, value] of Object.entries(map)) {
        const result = normalizeNode(value, false, `${path}.${key}`, depth + 1);
        if (!result.ok) return result;
        out[key] = result.schema;
    }
    return ok(out);
}

function normalizeComposition(node, key, path, depth) {
    const value = node[key];
    if (value === undefined) return ok(node);
    if (!Array.isArray(value)) return fail(`${path}.${key}: expected an array`);
    const schemas = [];
    for (let i = 0; i < value.length; i++) {
        const result = normalizeNode(value[i], false, `${path}.${key}[${i}]`, depth + 1);
        if (!result.ok) return result;
        schemas.push(result.schema);
    }
    node[key] = schemas;
    return ok(node);
}

function normalizeDefinitions(node, path, depth) {
    for (const key of ['$def', '$defs', 'definitions']) {
        const value = node[key];
        if (value === undefined) continue;
        if (!isPlainObject(value)) return fail(`${path}.${key}: expected an object`);
        const normalized = normalizeSubschemas(value, `${path}.${key}`, depth);
        if (!normalized.ok) return normalized;
        node[key] = normalized.schema;
    }
    return ok(node);
}

function normalizeObject(node, allowEmptyObject, path, depth) {
    let properties = node.properties;
    if (properties === undefined) properties = {};
    if (!isPlainObject(properties)) return fail(`${path}.properties: expected an object`);

    const normalizedProperties = {};
    for (const [name, value] of Object.entries(properties)) {
        const result = normalizeNode(value, false, `${path}.properties.${name}`, depth + 1);
        if (!result.ok) return result;
        normalizedProperties[name] = result.schema;
    }
    const names = Object.keys(normalizedProperties);
    if (names.length === 0 && !allowEmptyObject) {
        return fail(`${path}: An object with no properties is not allowed.`);
    }

    const required = node.required;
    if (required !== undefined) {
        if (!Array.isArray(required) || required.some(key => typeof key !== 'string')) {
            return fail(`${path}.required: expected an array of strings`);
        }
        const seen = new Set();
        for (const key of required) {
            if (!Object.prototype.hasOwnProperty.call(normalizedProperties, key)) {
                return fail(`${path}: Required property '${key}' not found in object`);
            }
            if (seen.has(key)) return fail(`${path}: Duplicate required property '${key}'`);
            seen.add(key);
        }
        if (seen.size !== names.length) {
            return fail(`${path}: Required properties must match all properties in the object`);
        }
    }

    const additional = node.additionalProperties;
    if (additional === true) {
        return fail(`${path}: additionalProperties should not be true`);
    }
    if (additional !== undefined && additional !== false) {
        return fail(`${path}: additionalProperties must be false`);
    }

    node.properties = normalizedProperties;
    node.required = names;
    node.additionalProperties = false;
    return ok(node);
}

function normalizeArray(node, path, depth) {
    if (node.items !== undefined) {
        if (Array.isArray(node.items)) {
            const items = [];
            for (let i = 0; i < node.items.length; i++) {
                const result = normalizeNode(node.items[i], false, `${path}.items[${i}]`, depth + 1);
                if (!result.ok) return result;
                items.push(result.schema);
            }
            node.items = items;
        } else {
            const result = normalizeNode(node.items, false, `${path}.items`, depth + 1);
            if (!result.ok) return result;
            node.items = result.schema;
        }
    }
    if (node.prefixItems !== undefined) {
        if (!Array.isArray(node.prefixItems)) return fail(`${path}.prefixItems: expected an array`);
        const items = [];
        for (let i = 0; i < node.prefixItems.length; i++) {
            const result = normalizeNode(node.prefixItems[i], false, `${path}.prefixItems[${i}]`, depth + 1);
            if (!result.ok) return result;
            items.push(result.schema);
        }
        node.prefixItems = items;
    }
    return ok(node);
}

function normalizeSubschemaAt(node, key, path, depth) {
    if (node[key] === undefined) return ok(node);
    const result = normalizeNode(node[key], false, `${path}.${key}`, depth + 1);
    if (!result.ok) return result;
    node[key] = result.schema;
    return ok(node);
}

function normalizeSubschemaMap(node, key, path, depth) {
    if (node[key] === undefined) return ok(node);
    const result = normalizeSubschemas(node[key], `${path}.${key}`, depth);
    if (!result.ok) return result;
    node[key] = result.schema;
    return ok(node);
}

function normalizeNode(schema, allowEmptyObject, path, depth) {
    if (depth > MAX_SCHEMA_DEPTH) return fail(`${path}: schema is too deeply nested`);
    if (!isPlainObject(schema)) return fail(`${path}: expected an object`);

    const node = { ...schema };
    const definitions = normalizeDefinitions(node, path, depth);
    if (!definitions.ok) return definitions;

    if (node.$ref !== undefined) return ok(node);

    if (node.type === 'object') {
        const result = normalizeObject(node, allowEmptyObject, path, depth);
        if (!result.ok) return result;
    } else if (node.type === 'array') {
        const result = normalizeArray(node, path, depth);
        if (!result.ok) return result;
    }

    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        const result = normalizeComposition(node, key, path, depth);
        if (!result.ok) return result;
    }
    for (const key of ['not', 'if', 'then', 'else', 'contains', 'propertyNames']) {
        const result = normalizeSubschemaAt(node, key, path, depth);
        if (!result.ok) return result;
    }
    for (const key of ['patternProperties', 'dependentSchemas']) {
        const result = normalizeSubschemaMap(node, key, path, depth);
        if (!result.ok) return result;
    }
    return ok(node);
}

// Normalize a schema for strict decoding. The top level must describe an
// object; `allowEmptyObject` is true only for a tool schema's top level.
function normalizeStrictSchema(schema, { allowEmptyObject = false } = {}) {
    if (!isPlainObject(schema) || schema.type !== 'object') {
        return fail('The top level of the schema must be an object.');
    }
    return normalizeNode(schema, allowEmptyObject, '$', 0);
}

function normalizeToolSchema(schema, name) {
    const parameters = schema === undefined || schema === null ? EMPTY_OBJECT_SCHEMA : schema;
    const result = normalizeStrictSchema(parameters, { allowEmptyObject: true });
    if (!result.ok) {
        return fail(`Invalid schema for function '${name}': ${result.error}`);
    }
    return result;
}

function normalizeResponseSchema(schema) {
    const result = normalizeStrictSchema(schema, { allowEmptyObject: false });
    if (!result.ok) return fail(`Invalid json schema: ${result.error}`);
    return result;
}

function normalizeStrictTools(tools) {
    for (const tool of tools) {
        if (!isPlainObject(tool)) continue;
        const functionObject = isPlainObject(tool.function) ? tool.function : null;
        const holder = functionObject || tool;
        const strict = functionObject ? functionObject.strict ?? tool.strict : tool.strict;
        if (strict !== true) continue;
        const name = functionObject?.name || tool.name || 'unknown';
        const result = normalizeToolSchema(holder.parameters, name);
        if (!result.ok) return result.error;
        holder.parameters = result.schema;
    }
    return null;
}

function normalizeChatRequestSchemas(params) {
    const format = params.response_format;
    if (isPlainObject(format) && format.type === 'json_schema') {
        if (!isPlainObject(format.json_schema)) {
            return 'Invalid json schema: json_schema is required';
        }
        if (format.json_schema.schema === undefined) {
            return 'Invalid json schema: schema is required';
        }
        if (format.json_schema.strict === true) {
            const result = normalizeResponseSchema(format.json_schema.schema);
            if (!result.ok) return result.error;
            format.json_schema.schema = result.schema;
        }
    }

    const tools = [];
    if (Array.isArray(params.tools)) tools.push(...params.tools);
    if (Array.isArray(params.functions)) tools.push(...params.functions);
    return normalizeStrictTools(tools);
}

function normalizeResponsesRequestSchemas(params) {
    const format = isPlainObject(params.text) && isPlainObject(params.text.format)
        ? params.text.format
        : null;
    if (format && format.type === 'json_schema') {
        if (format.schema === undefined) return 'Invalid json schema: schema is required';
        if (format.strict === true) {
            const result = normalizeResponseSchema(format.schema);
            if (!result.ok) return result.error;
            format.schema = result.schema;
        }
    }
    if (!Array.isArray(params.tools)) return null;
    return normalizeStrictTools(params.tools);
}

module.exports = {
    EMPTY_OBJECT_SCHEMA,
    MAX_SCHEMA_DEPTH,
    normalizeStrictSchema,
    normalizeResponseSchema,
    normalizeToolSchema,
    normalizeChatRequestSchemas,
    normalizeResponsesRequestSchemas,
};
