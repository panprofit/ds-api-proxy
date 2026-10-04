'use strict';
// Native DeepSeek tool-call markers: `<|tool▁calls▁begin|> … <|tool▁calls▁end|>`.
//
// The upstream can wrap a JSON array of calls in these markers. The JS proxy
// prompts for a different text format, but the upstream may still emit the
// native marker, so recognising it defensively avoids silently dropping a
// valid tool call.
//
// Matching is "fuzzy": the model occasionally hallucinates the separator
// characters, so U+FF5C (｜) is treated as equivalent to ASCII '|' and
// U+2581 (▁) as equivalent to '_'.

const { extractBalancedJsonObjects, parseJsonToolCandidate } = require('./json-repair');

const TOOL_CALL_START = '<|tool\u2581calls\u2581begin|>';
const TOOL_CALL_END = '<|tool\u2581calls\u2581end|>';

// Normalize one marker character to its canonical ASCII form.
function normTagChar(c) {
    if (c === '\uFF5C') return '|';
    if (c === '\u2581') return '_';
    return c;
}

// Are two marker characters equivalent under the fuzzy rules?
function eqTagChar(a, b) {
    return a === b || normTagChar(a) === normTagChar(b);
}

// Find `partial` in `haystack`, allowing the fuzzy character equivalences.
// Returns { index, match } where index is a UTF-16 string offset into
// `haystack`, or null. Operates on code points so a marker embedded after an
// astral character still reports the correct string offset.
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

// Locate an opening marker, exact match first then fuzzy. The trailing '>' is
// dropped from the needle so a partially-streamed marker is still found (the
// caller decides whether the content is complete).
function matchStartTag(s, tag) {
    const partial = tag.replace(/>+$/, '');
    const pos = s.indexOf(partial);
    if (pos !== -1) return { index: pos, match: s.slice(pos, pos + partial.length) };
    return fuzzyMatchTag(s, partial);
}

// A marker opener for the native grammar: `|tool▁calls▁begin|` (optionally
// without the leading/trailing pipe).
function looksLikeNativeMarker(text) {
    const value = String(text || '');
    if (!/[<\uFF1C]/.test(value)) return false;
    const normalized = value.replace(/\uFF5C/g, '|').replace(/\u2581/g, '_');
    return /<\|?\s*tool[_\s-]*calls[_\s-]*(?:begin|end)\s*\|?>/i.test(normalized);
}

// True when the text contains an opening native marker (complete or partial).
function containsNativeMarker(text) {
    const value = String(text || '');
    if (!value) return false;
    return Boolean(matchStartTag(value, TOOL_CALL_START));
}

// Is `pos` inside a ``` fenced code block? An odd number of fences before it.
function isInsideCodeFence(text, pos) {
    let count = 0;
    let idx = text.indexOf('```');
    while (idx !== -1 && idx < pos) { count++; idx = text.indexOf('```', idx + 3); }
    return count % 2 === 1;
}

// Find the closing marker at/after `from`. First the close derived from the
// given opening tag, then the canonical end marker (both exact then fuzzy).
function findEndTag(s, from, startTag) {
    const search = s.slice(from);
    const candidates = [];
    if (startTag) {
        const open = startTag.replace(/>+$/, '');
        // `</|tool▁calls▁begin|>` style: a close tag derived from the opener.
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

// Parse the native marker grammar out of `text`. Returns the FIRST tool call as
// `{ name, arguments }` (matching the single-call contract of parseToolCall),
// or null when there is no native marker or the payload does not parse.
function parseNativeToolCalls(text) {
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

    for (const rawJson of extractBalancedJsonObjects(inner)) {
        const tc = parseJsonToolCandidate(rawJson, 'native', { allowBare: true }, () => {});
        if (tc) return tc;
    }
    return null;
}

module.exports = {
    TOOL_CALL_START,
    TOOL_CALL_END,
    normTagChar,
    eqTagChar,
    fuzzyMatchTag,
    matchStartTag,
    findEndTag,
    isInsideCodeFence,
    containsNativeMarker,
    looksLikeNativeMarker,
    parseNativeToolCalls,
};
