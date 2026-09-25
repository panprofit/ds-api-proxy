'use strict';
// Tool-call parsing entry point. Supports strict JSON, DSML/XML markup and
// fenced JSON. The heavy lifting lives in two focused modules:
//   ./json-repair   balanced-JSON extraction + repair heuristics
//   ./parser-dsml   DSML/XML tag scanning + <invoke> grammar
// This module owns the top-level orchestration (fenced candidates, shell-fence
// fallback, repair ordering) and re-exports the helpers above so existing
// callers and tests can keep using `require('./parser')` unchanged.

const { debugLog } = require('./debug');
const {
    MAX_TOOL_MARKUP_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
    MAX_DSML_PARAMETERS,
    MAX_DSML_STRUCTURAL_TAGS,
    MAX_DSML_TAG_CHARS,
} = require('./parser-limits');
const {
    extractBalancedJsonAt,
    extractBalancedJsonObjects,
    repairJsonText,
    repairUnescapedQuotes,
    repairXmlLikeKeys,
    repairStrayClosingQuote,
    repairNestedStringValue,
    completeJsonClosers,
    splitConcatenatedToolCalls,
    buildToolCall,
    coerceToolCallObject,
    parseJsonToolCandidate,
    takeJsonParseError,
    resetJsonParseError,
} = require('./json-repair');
const {
    canonicalizeToolMarkupTag,
    normalizeToolMarkupTags,
    decodeDsmlValue,
    decodeDsmlParameterValue,
    getMarkupAttribute,
    readDsmlTagAt,
    scanDsmlStructuralTags,
    parseDsmlParameter,
    parseDsmlInvoke,
    extractToolCallScope,
    parseDsmlToolCall,
    looksLikeToolCallMarkup,
} = require('./parser-dsml');


// Detect *unbalanced* or unparsable tool markup, i.e. an opening tag that never
// closes or a JSON body that balances but does not parse. That is the real
// "broken/truncated" signal and is what should trigger a completion/retry, not
// a loose key match.
//
// DSML branch: an unclosed opening tag means truncated markup.
// JSON branch: markup key present but no candidate parses (raw control chars,
// trailing commas, or a genuinely truncated object) means the call needs a
// repair pass. Without this the balanced-but-invalid JSON was misclassified as
// a dead account and rotated instead of being retried.
function hasUnclosedToolMarkup(text) {
    const value = String(text || '');
    if (!looksLikeToolCallMarkup(value)) return false;
    if (/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(value)) {
        const normalized = normalizeToolMarkupTags(value);
        if (scanDsmlStructuralTags(normalized) === null) return true;
    }
    // JSON-shaped markup that does not yield a call *even after the local
    // repair pass* is genuinely broken/truncated. Repairable glitches
    // (trailing commas, raw newlines in strings) now parse successfully, so
    // `hasUnclosedToolMarkup` returns false for them and no pointless
    // continuation round is issued for a call that was already understood.
    if (parseToolCall(value, () => {}) === null) {
        // Distinguish "repair made it parse" from "still broken". The first
        // branch of parseToolCall already succeeded for repairable input, so
        // reaching here means the repair did not produce a call.
        return true;
    }
    return false;
}

function parseToolCall(text, log = console.log) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }
    resetJsonParseError();

    // Mirror looksLikeToolCallMarkup: a bare `|DSML|` token in prose is not
    // markup. A real DSML marker only counts when accompanied by an actual
    // tag opener (`<`/`＜`).
    const hasDsml = /<\s*tool_call\b/i.test(text)
        || (/[|｜]+\s*DSML\s*[|｜]+/i.test(text) && /[<＜]/.test(text))
        || /[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(text);

    // Models sometimes emit a complete JSON tool call and then a duplicate
    // (often truncated) DSML/XML rendering of the same call. The JSON is the
    // authoritative copy, so try every JSON shape first and only fall back to
    // the DSML parser when none of them yields a call. Previously the DSML
    // branch ran first, so a valid leading JSON call was discarded whenever a
    // stray DSML marker appeared later in the text.
    const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        const tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true }, log);
        if (tc) return tc;
    }

    // Fenced candidates. The language tag matters: DeepSeek frequently wraps a
    // shell command in ```sh/```bash even when the intended tool is `bash`.
    // Parsing those bodies as JSON always fails (they start with a comment or a
    // command, not `{`), so:
    //   * a bare/```json fence is probed as JSON as before;
    //   * a ```sh/```bash/```shell fence is offered to the bash heuristic below;
    //   * any other language (```js, ```yaml, ...) is skipped instead of burning
    //     a JSON.parse probe that can never succeed.
    const fenceRe = /```([^\n`]*)\n?([\s\S]*?)```/g;
    const shellFenceBodies = [];
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        const lang = String(fence[1] || '').trim().toLowerCase();
        const body = fence[2].trim();
        if (!body) continue;
        if (lang === 'sh' || lang === 'bash' || lang === 'shell' || lang === 'console') {
            shellFenceBodies.push(body);
            continue;
        }
        if (lang && lang !== 'json' && lang !== 'tool_call' && lang !== 'tool') continue;
        const tc = parseJsonToolCandidate(body, 'fenced', {}, log);
        if (tc) return tc;
        // The model sometimes double-encodes the JSON as a string literal inside
        // the fence (`"\n{\n  \"tool_call\"..."`). If the body itself is a JSON
        // string, decode it once and retry.
        if (body[0] === '"') {
            try {
                const decoded = JSON.parse(body);
                if (typeof decoded === 'string' && decoded.trim()) {
                    const tc2 = parseJsonToolCandidate(decoded.trim(), 'fenced-decoded', {}, log);
                    if (tc2) return tc2;
                }
            } catch (e) { /* not a JSON string, fall through */ }
        }
    }
    // A ```sh/```bash fence almost always means "run this as a shell command".
    // `parseToolCall` has no allowed-tool set, so do NOT synthesize a bash call
    // here when real JSON markup is present: a JSON tool call (or a broken one
    // the recovery passes should retry) is authoritative. Only when the text
    // has no tool-call shape at all do we fall back to the first shell fence.
    //
    // CRITICAL: require the shell fence to be the ENTIRE message. The model
    // routinely embeds an illustrative fenced command inside a prose answer
    // ("вот как это сделать: ```bash …```"). Turning that into a real bash
    // call makes the gateway execute the snippet and the agent loops forever,
    // which also violates the tool system prompt ("never add explanation
    // before or after"). A lone fenced block is a genuine request; a fence
    // surrounded by prose is not. The caller re-checks the name against
    // `allowedToolNames` after parsing.
    const shellFenceOnly = shellFenceBodies.length === 1
        && text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, '').trim() === '';
    if (shellFenceOnly && !looksLikeToolCallMarkup(text)) {
        const tc = buildToolCall('bash', { command: shellFenceBodies[0] });
        if (tc) {
            log(`[parseToolCall] SUCCESS fenced-shell: bash (args=${tc.arguments.length} chars)`);
            return tc;
        }
    }

    for (const rawJson of extractBalancedJsonObjects(text)) {
        const tc = parseJsonToolCandidate(rawJson, 'inline', {}, log);
        if (tc) return tc;
    }

    // The raw text may contain unescaped quotes inside a string value, which
    // makes the brace scanner lose string state and yield no candidate at all.
    // Repair control chars first (repairJsonText), then the literal quotes, then
    // retry the balanced-object extraction.
    const controlRepaired = repairJsonText(text);
    const quoteRepaired = repairUnescapedQuotes(controlRepaired);
    if (quoteRepaired !== text) {
        for (const rawJson of extractBalancedJsonObjects(quoteRepaired)) {
            const tc = parseJsonToolCandidate(rawJson, 'inline-quotes-repaired', {}, log);
            if (tc) return tc;
        }
    }

    // XML-like keys / glued literals (`id="x""name"`). Same guard as
    // parseJsonToolCandidate so ordinary prose is never rewritten. Run the
    // XML-like fix on the *control*-repaired text (not the quote-repaired one:
    // repairUnescapedQuotes already turned the glued `""` into `\"\"`, which
    // the adjacent-literal rule no longer recognises), then quote-repair, then
    // append any missing closing braces.
    if (/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(text)) {
        const xmlRepaired = repairXmlLikeKeys(controlRepaired);
        if (xmlRepaired !== controlRepaired) {
            const xmlThenQuotes = repairUnescapedQuotes(xmlRepaired);
            for (const rawJson of extractBalancedJsonObjects(xmlThenQuotes)) {
                const tc = parseJsonToolCandidate(rawJson, 'inline-xml-keys-repaired', {}, log);
                if (tc) return tc;
            }
            // Concatenated calls that lost the comma between them:
            // `...}}{"tool_call":{...}}`. Split, then parse each half (the
            // first also needs its missing closers appended).
            for (const rawJson of extractBalancedJsonObjects(splitConcatenatedToolCalls(xmlThenQuotes))) {
                const tc = parseJsonToolCandidate(rawJson, 'inline-xml-keys-concat-repaired', {}, log);
                if (tc) return tc;
            }
            const completed = completeJsonClosers(xmlThenQuotes);
            if (completed) {
                const tc = parseJsonToolCandidate(completed, 'inline-xml-keys-completed', {}, log);
                if (tc) return tc;
            }
        }
    }

    // A value whose closing quote was dropped before the trailing braces
    // (`"limit":35"}}}`) desyncs the brace scanner, so `extractBalancedJsonObjects`
    // returns nothing and none of the repairs above are even reachable. Drop the
    // stray quote on the control-repaired text and retry the extraction.
    const strayRepaired = repairStrayClosingQuote(controlRepaired);
    if (strayRepaired !== controlRepaired) {
        for (const rawJson of extractBalancedJsonObjects(strayRepaired)) {
            const tc = parseJsonToolCandidate(rawJson, 'inline-stray-quote-repaired', {}, log);
            if (tc) return tc;
        }
    }

    // A single string argument whose value embeds a nested JSON/JS body escaped
    // one level too few (`bash` command with `node -e '...'`). The inner quotes
    // close the outer value early, so `extractBalancedJsonObjects` yields
    // nothing and none of the repairs above are reachable. Re-escape only that
    // value and retry.
    const nestedRepaired = repairNestedStringValue(controlRepaired);
    if (nestedRepaired !== controlRepaired) {
        for (const rawJson of extractBalancedJsonObjects(nestedRepaired)) {
            const tc = parseJsonToolCandidate(rawJson, 'inline-nested-value-repaired', {}, log);
            if (tc) return tc;
        }
    }

    if (hasDsml) {
        const dsml = parseDsmlToolCall(text, log);
        if (dsml) return dsml;
        debugLog(log, `[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed; unparsed text (${text.length} chars): ${JSON.stringify(text.substring(0, MAX_TOOL_MARKUP_CHARS))}`);
        return null;
    }

    // Diagnostic only: gate behind DS_DEBUG so expected JSON-parse probes
    // do not spam normal logs.
    debugLog(log, `[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}

module.exports = {
    MAX_TOOL_MARKUP_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
    MAX_DSML_PARAMETERS,
    MAX_DSML_STRUCTURAL_TAGS,
    MAX_DSML_TAG_CHARS,
    extractBalancedJsonAt,
    extractBalancedJsonObjects,
    repairJsonText,
    repairUnescapedQuotes,
    repairXmlLikeKeys,
    repairStrayClosingQuote,
    repairNestedStringValue,
    completeJsonClosers,
    splitConcatenatedToolCalls,
    buildToolCall,
    coerceToolCallObject,
    parseJsonToolCandidate,
    canonicalizeToolMarkupTag,
    normalizeToolMarkupTags,
    decodeDsmlValue,
    decodeDsmlParameterValue,
    getMarkupAttribute,
    readDsmlTagAt,
    scanDsmlStructuralTags,
    parseDsmlParameter,
    parseDsmlInvoke,
    extractToolCallScope,
    parseDsmlToolCall,
    looksLikeToolCallMarkup,
    hasUnclosedToolMarkup,
    parseToolCall,
    takeJsonParseError,
};
