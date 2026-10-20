'use strict';
// Tool-markup diagnostics: detect and describe truncated tool-call markup so
// phaseBrokenMarkup can log why it rotates the account.

const {
    parseToolCall, looksLikeToolCallMarkup,
    looksLikeNativeMarker, scanDsmlStructuralTags, normalizeToolMarkupTags,
    MAX_TOOL_MARKUP_CHARS, takeJsonParseError,
} = require('./parser');
const { debugLogEnv, isDebugEnabled } = require('./debug');
const { truncateForLog } = require('./http');

// --- tool-markup diagnostics ----------------------------------------------
function describeToolMarkup(content) {
    const value = String(content || '');
    let hasDsml = false;
    try {
        hasDsml = /(?:[|｜]+\s*DSML\s*[|｜]*|[|｜]*\s*DSML\s*[|｜]+)|[<＜]\s*\/?\s*(?:[|｜/]*\s*DSML\s*[|｜/]*\s*)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(value);
    } catch (e) { hasDsml = false; }
    // Native `<|tool▁calls▁begin|>` markers carry a bare JSON array that the
    // DSML scanner does not see; report them as their own shape so the
    // recovery log distinguishes "truncated native call" from "truncated DSML".
    let hasNative = false;
    try { hasNative = looksLikeNativeMarker(value); } catch (e) { hasNative = false; }

    let parseError = null;
    try {
        const tc = parseToolCall(value, () => {});
        if (!tc) {
            // parseToolCall swallows the real JSON.parse error; take the last
            // recorded one so the log says *why* it failed (e.g. "Expected ','
            // or '}' ... at position 802" = truncated object) instead of a
            // useless "no-call".
            const jsonErr = takeJsonParseError();
            parseError = jsonErr ? `json:${compactMsg(jsonErr)}` : 'no-call';
        }
    } catch (e) { parseError = `parse-threw:${e && e.message ? e.message : e}`; }

    let dsmlTags = 'n/a';
    if (hasDsml) {
        try {
            const tags = scanDsmlStructuralTags(normalizeToolMarkupTags(value));
            dsmlTags = tags === null ? 'unbalanced/oversized' : String(tags.length);
        } catch (e) { dsmlTags = `scan-threw:${e && e.message ? e.message : e}`; }
    }

    const compact = (t, max) => truncateForLog(String(t).replace(/\s+/g, ' ').trim(), max, '');
    return {
        length: value.length,
        looksLikeMarkup: looksLikeToolCallMarkup(value),
        shape: hasNative ? 'native' : (hasDsml ? 'dsml' : 'json'),
        dsmlTags,
        parseError,
        head: compact(value, 80),
        tail: compact(value.slice(-200), 200),
    };
}

// Shorten a JSON.parse error for a single-line log field: keep the position
// info but drop the noisy "(line 1 column N)" suffix and cap the length.
function compactMsg(msg) {
    return String(msg || '').replace(/\s*\(line \d+ column \d+\)/, '').slice(0, 120);
}

// Dedupe the full markup dump: it is called on every completion round and on
// the strict retry, but the content often does not change between calls. Emit
// the dump only when the value differs from the previous one for this agent.
// Bounded to avoid unbounded growth across many agentTags (one per
// conversation): keep at most MAX_MARKUP_DUMP_ENTRIES and evict the
// least-recently-touched entry.
const MAX_MARKUP_DUMP_ENTRIES = 256;
const lastMarkupDump = new Map();
// `env` is an injectable seam for tests: when omitted the switch is read from
// the real process.env. Callers that already hold an injected env pass it so
// the gate and the log share one switch.
function debugDumpToolMarkup(agentTag, content, log = console.log, env = process.env) {
    if (!isDebugEnabled(env)) return;
    const value = String(content || '');
    const fingerprint = `${value.length}:${value.slice(-80)}`;
    if (lastMarkupDump.get(agentTag) === fingerprint) return;
    // Refresh recency: delete+set moves the key to the end of the iteration
    // order, so Map.keys().next() is always the least-recently-touched entry.
    lastMarkupDump.delete(agentTag);
    lastMarkupDump.set(agentTag, fingerprint);
    if (lastMarkupDump.size > MAX_MARKUP_DUMP_ENTRIES) {
        const oldest = lastMarkupDump.keys().next().value;
        lastMarkupDump.delete(oldest);
    }
    debugLogEnv(log, env, `${agentTag} [markup-dump] len=${value.length} cap=${MAX_TOOL_MARKUP_CHARS}`);
    const preview = truncateForLog(value, 2000, '');
    debugLogEnv(log, env, `${agentTag} [markup-dump] ${JSON.stringify(preview)}${value.length > preview.length ? `…(+${value.length - preview.length} chars)` : ''}`);
}

module.exports = {
    describeToolMarkup,
    debugDumpToolMarkup,
};
