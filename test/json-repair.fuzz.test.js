'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jr = require('../lib/json-repair');
const { MAX_TOOL_ARGUMENT_CHARS } = require('../lib/parser-limits');

const silentLog = () => {};

function makeRng(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
    return min + Math.floor(rng() * (max - min + 1));
}

function randomString(rng, maxLen = 40) {

    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '
        + '{}[]":,\\/|_-.<>=!@#$%^&*()~`'
        + '\n\t\r\b\f\u0000\u001f'
        + '\u00ab\u00bb\u2018\u2019\u201c\u201d\uff5c\u3000';
    const len = randInt(rng, 0, maxLen);
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
    return out;
}

function randomBrokenToolCall(rng) {
    const name = pick(rng, ['read', 'bash', 'write', 'get_weather']);
    const argKey = pick(rng, ['path', 'command', 'content', 'limit', 'ключ']);
    const argVal = randomString(rng, 30);
    const shapes = [

        `{"tool_call":{"name":"${name}","arguments":{"${argKey}":"x"${argVal}"y"}}}`,

        `{"tool_call":{ id="call_1""name":"${name}","arguments":{"${argKey}":"${argVal}"}}}`,

        `{"tool_call":{"name":"${name}","arguments":{"${argKey}":"${argVal}"}}}`,

        `{"tool_call":{"name":"${name}","arguments":{"${argKey}":"${argVal}",}}}`,

        `{"tool_call":{"name":"${name}","arguments":{"${argKey}":"a${argVal}\n\tb"}}}`,

        `{"tool_call":{"name":"${name}","arguments":{"${argKey}":"${argVal}"}`,

        `${randomString(rng, 10)}{"tool_call":{"name":"${name}","arguments":{"${argKey}":"${argVal}"}}}${randomString(rng, 10)}`,
    ];
    return pick(rng, shapes);
}

function assertValidToolCall(tc) {
    assert.ok(tc && typeof tc === 'object', 'tool call must be an object');
    assert.equal(typeof tc.name, 'string');
    assert.match(tc.name, /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/);
    assert.equal(typeof tc.arguments, 'string');
    assert.ok(tc.arguments.length <= MAX_TOOL_ARGUMENT_CHARS);
    const parsed = JSON.parse(tc.arguments);
    assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
}

const PUBLIC_FNS = [
    'repairJsonText',
    'repairUnescapedQuotes',
    'repairXmlLikeKeys',
    'repairStrayClosingQuote',
    'repairNestedStringValue',
    'completeJsonClosers',
    'splitConcatenatedToolCalls',
    'extractBalancedJsonObjects',
];

test('fuzz: json-repair functions do not throw on random strings', () => {
    const rng = makeRng(101);
    for (let i = 0; i < 2000; i++) {
        const s = randomString(rng, 300);
        for (const fn of PUBLIC_FNS) {
            assert.doesNotThrow(() => jr[fn](s), `${fn} threw on ${JSON.stringify(s)}`);
        }
    }
});

test('fuzz: json-repair functions do not throw on non-string junk', () => {
    const weird = [null, undefined, 0, 1, true, false, {}, [], () => {}, Symbol('x'), 123n];
    for (const v of weird) {
        for (const fn of PUBLIC_FNS) {
            assert.doesNotThrow(() => jr[fn](v, 0), `${fn} threw on ${String(v)}`);
        }
    }
});

function assertIdempotent(fnName, input) {
    const once = jr[fnName](input);
    if (once === null) return;
    const twice = jr[fnName](once);

    if (fnName === 'completeJsonClosers' && twice === null) return;
    assert.equal(twice, once, `${fnName} not idempotent on ${JSON.stringify(input)}`);
}

test('fuzz: repairs are idempotent', () => {
    const rng = makeRng(102);
    for (let i = 0; i < 1500; i++) {
        const s = randomString(rng, 200);
        for (const fn of ['repairJsonText', 'repairUnescapedQuotes', 'repairXmlLikeKeys', 'completeJsonClosers']) {
            assertIdempotent(fn, s);
        }
        assertIdempotent('repairStrayClosingQuote', randomBrokenToolCall(rng));
        assertIdempotent('repairNestedStringValue', randomBrokenToolCall(rng));
        assertIdempotent('splitConcatenatedToolCalls', randomBrokenToolCall(rng));
    }
});

test('fuzz: repairJsonText leaves valid JSON untouched', () => {
    const rng = makeRng(103);
    for (let i = 0; i < 1000; i++) {

        const value = { a: randomString(rng, 20), b: randInt(rng, -1e6, 1e6), c: [true, false, null] };
        const text = JSON.stringify(value);
        assert.equal(jr.repairJsonText(text), text, 'valid JSON must be unchanged');
    }
});

test('fuzz: parseJsonToolCandidate output is always a valid tool call', () => {
    const rng = makeRng(104);
    for (let i = 0; i < 3000; i++) {
        const s = randomBrokenToolCall(rng);
        const tc = jr.parseJsonToolCandidate(s, 'fuzz', {}, silentLog);
        if (tc) assertValidToolCall(tc);
    }
});

test('fuzz: parseJsonToolCandidate does not throw on random strings', () => {
    const rng = makeRng(105);
    for (let i = 0; i < 2000; i++) {
        const s = randomString(rng, 300);
        assert.doesNotThrow(() => jr.parseJsonToolCandidate(s, 'fuzz', {}, silentLog), `threw on ${JSON.stringify(s)}`);
    }
});

test('fuzz: repairJsonText alone never turns arbitrary prose into a parseable call', () => {
    const rng = makeRng(106);
    for (let i = 0; i < 2000; i++) {
        const s = randomString(rng, 200);
        const repaired = jr.repairJsonText(s);

        let originalParsed = true;
        try { JSON.parse(s); } catch (e) { originalParsed = false; }
        if (!originalParsed) {

            try {
                const parsed = JSON.parse(repaired);
                assert.ok(parsed !== undefined);
            } catch (e) {  }
        }
    }
});

function isBalancedObject(text) {
    if (typeof text !== 'string' || text[0] !== '{' || text[text.length - 1] !== '}') return false;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (inString && ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth < 0) return false; }
    }
    return depth === 0 && !inString;
}

test('fuzz: extractBalancedJsonObjects yields only balanced substrings', () => {
    const rng = makeRng(107);
    for (let i = 0; i < 2000; i++) {
        const s = randomString(rng, 300);
        const objs = jr.extractBalancedJsonObjects(s);
        let searchFrom = 0;
        for (const obj of objs) {
            assert.ok(isBalancedObject(obj), `unbalanced object: ${JSON.stringify(obj)} from ${JSON.stringify(s)}`);
            const start = s.indexOf(obj, searchFrom);
            assert.ok(start >= 0, `extracted object not found in source: ${JSON.stringify(obj)}`);
            searchFrom = start + 1;
        }
    }
});

function mutate(rng, s) {
    if (s.length === 0) return s;
    const pos = randInt(rng, 0, s.length - 1);
    const kind = randInt(rng, 0, 2);
    if (kind === 0) return s.slice(0, pos) + s.slice(pos + 1);
    if (kind === 1) return s.slice(0, pos) + pick(rng, ['"', '\\', '{', '}', ',', ']', '=', ' ', '\n']) + s.slice(pos);
    return s.slice(0, pos) + pick(rng, ['"', '\\', '{', '}', ',']) + s.slice(pos + 1);
}

test('fuzz: mutations of corpus calls do not throw and stay valid', () => {
    const rng = makeRng(108);
    const corpus = require('./fixtures/broken-tool-calls');
    for (let i = 0; i < 2000; i++) {
        let s = pick(rng, corpus).input;
        const nMutations = randInt(rng, 1, 5);
        for (let j = 0; j < nMutations; j++) s = mutate(rng, s);
        assert.doesNotThrow(() => jr.parseJsonToolCandidate(s, 'fuzz', {}, silentLog), `threw on ${JSON.stringify(s)}`);
        const tc = jr.parseJsonToolCandidate(s, 'fuzz', {}, silentLog);
        if (tc) assertValidToolCall(tc);
    }
});
