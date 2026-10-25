'use strict';

const { extractBalancedJsonObjects, parseJsonToolCandidate, coerceToolCallList } = require('./json-repair');

const TOOL_CALL_START = '<|tool\u2581calls\u2581begin|>';
const TOOL_CALL_END = '<|tool\u2581calls\u2581end|>';

function normTagChar(c) {
    if (c === '\uFF5C') return '|';
    if (c === '\u2581') return '_';
    return c;
}

function eqTagChar(a, b) {
    return a === b || normTagChar(a) === normTagChar(b);
}

function fuzzyMatchTag(haystack, partial) {
    const h = Array.from(haystack);
    const p = Array.from(partial);
    if (p.length === 0 || h.length < p.length) return null;
    for (let start = 0; start <= h.length - p.length; start++) {
        let ok = true;
        for (let j = 0; j < p.length; j++) {
            if (!eqTagChar(h[start + j], p[j])) { ok = false; break; }
        }
        if (ok) {
            let index = 0;
            for (let k = 0; k < start; k++) index += h[k].length;
            return { index, match: h.slice(start, start + p.length).join('') };
        }
    }
    return null;
}

function matchStartTag(s, tag) {
    const partial = tag.replace(/>+$/, '');
    const pos = s.indexOf(partial);
    if (pos !== -1) return { index: pos, match: s.slice(pos, pos + partial.length) };
    return fuzzyMatchTag(s, partial);
}

function looksLikeNativeMarker(text) {
    const value = String(text || '');
    if (!/[<\uFF1C]/.test(value)) return false;
    const normalized = value.replace(/\uFF5C/g, '|').replace(/\u2581/g, '_');
    return /<\|?\s*tool[_\s-]*calls[_\s-]*(?:begin|end)\s*\|?>/i.test(normalized);
}

function containsNativeMarker(text) {
    const value = String(text || '');
    if (!value) return false;
    return Boolean(matchStartTag(value, TOOL_CALL_START));
}

function isInsideCodeFence(text, pos) {
    let count = 0;
    let idx = text.indexOf('```');
    while (idx !== -1 && idx < pos) { count++; idx = text.indexOf('```', idx + 3); }
    return count % 2 === 1;
}

function findEndTag(s, from, startTag) {
    const search = s.slice(from);
    const candidates = [];
    if (startTag) {
        const open = startTag.replace(/>+$/, '');

        candidates.push(`</${open.slice(1)}>`);
    }
    candidates.push(TOOL_CALL_END);
    for (const end of candidates) {
        const partial = end.replace(/>+$/, '');
        const pos = search.indexOf(partial);
        if (pos !== -1) return { index: from + pos, match: search.slice(pos, pos + partial.length) };
        const fuzzy = fuzzyMatchTag(search, partial);
        if (fuzzy) return { index: from + fuzzy.index, match: fuzzy.match };
    }
    return null;
}

function expandToolCallObject(rawJson) {
    try {
        return coerceToolCallList(JSON.parse(rawJson), { allowBare: true }) || [];
    } catch (e) {
        return [];
    }
}

function parseNativeToolCallList(text) {
    if (!text || typeof text !== 'string') return null;
    const start = matchStartTag(text, TOOL_CALL_START);
    if (!start) return null;
    if (isInsideCodeFence(text, start.index)) return null;

    const afterStart = start.index + start.match.length;
    const end = findEndTag(text, afterStart, start.match);
    const inner = end
        ? text.slice(afterStart, end.index)
        : text.slice(afterStart);
    if (!inner.trim() || inner.trim() === '[]') return null;

    const calls = [];
    for (const rawJson of extractBalancedJsonObjects(inner)) {
        const tc = parseJsonToolCandidate(rawJson, 'native', { allowBare: true }, () => {});
        if (tc) {
            calls.push(tc);
            continue;
        }
        calls.push(...expandToolCallObject(rawJson));
    }
    return calls.length > 0 ? calls : null;
}

function parseNativeToolCalls(text) {
    const calls = parseNativeToolCallList(text);
    return calls && calls.length > 0 ? calls[0] : null;
}

module.exports = {
    TOOL_CALL_START,
    TOOL_CALL_END,
    normTagChar,
    eqTagChar,
    containsNativeMarker,
    looksLikeNativeMarker,
    parseNativeToolCalls,
    parseNativeToolCallList,
};
