'use strict';
// Balanced-JSON extraction and repair for tool-call markup. The repair
// heuristics (raw control chars, unescaped quotes, XML-like keys, nested
// string values, truncation) are reviewed and fuzz-tested independently of the
// DSML markup parser. parser.js re-exports every function here, so
// `require('./parser')` still exposes them.

const {
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
} = require('./parser-limits');
function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    const end = findJsonObjectEnd(text, startIndex);
    return end === -1 ? null : text.substring(startIndex, end + 1);
}

// Cheap, non-destructive repair for the two JSON glitches DeepSeek most often
// emits inside an otherwise well-formed tool call: raw control characters
// (real newlines/tabs) inside string literals, and trailing commas before a
// closing brace/bracket. Both make `JSON.parse` throw while the surrounding
// braces still balance, which previously left the call stuck as plain text.
// Returns the repaired string, or the original when no repair applied.
function repairJsonText(raw) {
    const input = String(raw || '');
    if (!input) return input;
    let out = '';
    let inString = false;
    let escape = false;
    // Trailing-comma removal must also respect string literals: a `,}` inside
    // a string is data, not a trailing comma. Track the pending comma outside
    // strings and only drop it when the next significant char is `}` or `]`.
    let pendingComma = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (escape) { out += ch; escape = false; continue; }
        if (inString && ch === '\\') { out += ch; escape = true; continue; }
        if (ch === '"') {
            if (pendingComma) { out += ','; pendingComma = false; }
            inString = !inString; out += ch; continue;
        }
        if (inString && ch.charCodeAt(0) < 0x20) {
            // Encode the raw control character as a JSON escape so the string
            // stays a string instead of terminating the literal early.
            switch (ch) {
                case '\n': out += '\\n'; break;
                case '\r': out += '\\r'; break;
                case '\t': out += '\\t'; break;
                case '\b': out += '\\b'; break;
                case '\f': out += '\\f'; break;
                default: out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
            }
            continue;
        }
        if (inString) { out += ch; continue; }
        if (ch === ',') { pendingComma = true; continue; }
        if (pendingComma) {
            // The comma was not followed by `}`/`]`, so it is a real separator.
            if (ch !== '}' && ch !== ']') out += ',';
            pendingComma = false;
        }
        out += ch;
    }
    if (pendingComma) out += ',';
    return out;
}

// Last-resort repair for the most damaging DeepSeek glitch: a double quote
// inside a string value emitted *without* a backslash (very common when the
// value is a large file body full of `echo "..."`). A raw `"` toggles the
// parser's string state, so the enclosing object never balances and the whole
// tool call is lost as plain text. `repairJsonText` cannot fix this because it
// deliberately keeps every `"` it sees.
//
// Heuristic: walk the text with JSON string/escape state. When a `"` that would
// *close* the current string is followed (after optional whitespace) by a
// character that cannot legally follow a closed value, treat it as a literal
// quote that belongs to the value and escape it. This is safe for the shapes
// this proxy accepts (tool_call/arguments/edits/...) because a closing quote is
// always followed by `:`, `,`, `}`, `]` or end-of-input. Returns the repaired
// string, or the original when nothing changed.
function repairUnescapedQuotes(raw) {
    const input = String(raw || '');
    if (!input) return input;
    let out = '';
    let inString = false;
    let escape = false;
    let changed = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (escape) { out += ch; escape = false; continue; }
        if (inString && ch === '\\') { out += ch; escape = true; continue; }
        if (ch === '"') {
            if (!inString) { inString = true; out += ch; continue; }
            // Candidate closing quote. Peek past whitespace and any run of
            // adjacent quotes for the first significant char. A run like `""`
            // before `}` is a data quote followed by the real closing quote:
            // only the LAST quote of the run may close the value.
            let j = i + 1;
            while (j < input.length && /[ \t\r\n"]/.test(input[j])) j++;
            const next = j < input.length ? input[j] : '';
            const isBoundary = next === ':' || next === ',' || next === '}' || next === ']' || next === '';
            let k = i + 1;
            while (k < input.length && /[ \t\r\n]/.test(input[k])) k++;
            let quotesAhead = 0;
            while (k + quotesAhead < input.length && input[k + quotesAhead] === '"') quotesAhead++;
            if (isBoundary && quotesAhead === 0) {
                inString = false;
                out += ch;
            } else {
                // Not the last quote before a legal boundary: literal data.
                out += '\\"';
                changed = true;
            }
            continue;
        }
        out += ch;
    }
    return changed ? out : input;
}

// Last-resort repair for a tool call where the model used XML-like attribute
// syntax for object keys and then glued the next key onto the previous string
// literal:
//
//   {"tool_call":{ id="call_1""name":"read","arguments":{...}}}
//
// `repairJsonText` and `repairUnescapedQuotes` cannot fix this: the `=` is not
// a quote problem and the missing comma is not a trailing comma. Two targeted
// rewrites recover the common shape:
//   1. `key="value` -> `"key":"value`   (attribute syntax -> JSON member)
//   2. `"value""nextKey"` -> `"value","nextKey"` (insert the missing comma)
// Only safe because callers gate this on the tool-call shape; it is not a
// general JSON repair.
function repairXmlLikeKeys(raw) {
    const input = String(raw || '');
    if (!input) return input;
    let out = input.replace(/\b([A-Za-z_]\w*)\s*=\s*"/g, '"$1":"');
    out = out.replace(/"(\s*)"(?=[A-Za-z_]\w*"\s*:)/g, '",$1"');
    return out === input ? input : out;
}

// Repair a tool call where the model glued two calls together with `}}{"tool_call"`
// and dropped the comma, and left the first object one or two braces short:
//
//   {"tool_call":{ id="...""name":"write",...}}{\n"}}{"tool_call":{"name":"bash",...}}
//
// The real fix is to split at each `}}{"tool_call"` boundary, re-balance each
// object independently (append its missing closers) and re-emit them as a
// comma-joined sequence so the existing balanced-object extractor can parse
// both. Returns the input unchanged when there is nothing to split.
function splitConcatenatedToolCalls(raw) {
    const input = String(raw || '');
    if (!input) return input;
    const parts = input.split(/}\}\s*(?={"tool_call")/);
    if (parts.length < 2) return input;
    const repaired = [];
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        // Every part except the last is missing the `}}` removed by the split;
        // restore one closing brace. A part that is already balanced (the
        // trailing call) is accepted as-is; a truncated one gets the missing
        // closers appended. Only give up if a part still cannot be balanced.
        if (i < parts.length - 1) part += '}';
        const completed = completeJsonClosers(part) ?? part;
        try { JSON.parse(completed); } catch (e) { return input; }
        repaired.push(completed);
    }
    return repaired.join(',');
}

// Last-resort repair for a value whose closing quote was *dropped* before the
// object's trailing braces:
//
//   {"tool_call":{"name":"read","arguments":{"path":"/x","limit":35"}}}
//
// Here the model wrote a numeric-looking value, then a stray `"` and then the
// closing braces. That single `"` toggles the brace scanner's string state, so
// `findJsonObjectEnd` never balances and the whole call is lost as plain text.
// `repairUnescapedQuotes` cannot help: its rule is "a quote not followed by
// `:`/`,`/`}`/`]` is data", and this quote *is* followed by `}`.
//
// Fix: if a `"` sits immediately before the trailing run of closers and
// removing it makes the text balance with an empty string state, drop it.
// Gated on the tool-call shape so ordinary prose is never rewritten. Returns
// the input when nothing safe applies.
function repairStrayClosingQuote(raw) {
    const input = String(raw || '');
    if (!input) return input;
    if (!/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(input)) return input;
    const quoteRe = /"/g;
    let match;
    while ((match = quoteRe.exec(input)) !== null) {
        const i = match.index;
        // The quote must be the last meaningful token, followed only by
        // whitespace and closing braces/brackets through end of input.
        if (!/^[\s}\]]*$/.test(input.slice(i + 1))) continue;
        const candidate = input.slice(0, i) + input.slice(i + 1);
        let depth = 0;
        let inString = false;
        let escape = false;
        let valid = true;
        for (let k = 0; k < candidate.length; k++) {
            const ch = candidate[k];
            if (escape) { escape = false; continue; }
            if (inString && ch === '\\') { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            if (ch === '}') depth--;
            if (depth < 0) { valid = false; break; }
        }
        if (valid && depth === 0 && !inString) return candidate;
    }
    return input;
}

// Repair a tool call whose single string argument embeds a nested JSON/JS body
// that was escaped one level too few (and may contain raw newlines):
//
//   {"tool_call":{"name":"bash","arguments":{"command":"node -e '
//   console.log("hi");
//   '"}}}
//
// The inner `"` closes the outer value early, so the brace scanner desyncs and
// `extractBalancedJsonObjects` yields nothing. `repairJsonText` cannot help
// because it thinks those quotes are legal string boundaries; `repairUnescapedQuotes`
// runs too late (no candidate is ever extracted) and would also mis-handle the
// raw newlines.
//
// The repair is deliberately narrow: it only fires for the exact wrapper
// `{"tool_call":{"name":..,"arguments":{"KEY":"VALUE"}}}` whose object does
// NOT already parse, and only re-escapes the VALUE. Literal backslash sequences
// in the value are preserved (they are copied verbatim), so a valid object is
// never touched. Returns the input when the shape does not match.
function repairNestedStringValue(raw) {
    const input = String(raw || '');
    if (!input) return input;
    const match = input.match(/^(\{"tool_call":\{"name":"([^"]+)","arguments":\{"([^"]+)":")([\s\S]*)("\}\}\})$/);
    if (!match) return input;
    const [, head, , , value, tail] = match;
    // Never rewrite an object that already parses: the narrow decode below can
    // otherwise corrupt a value that legitimately contains `\\n`-style data.
    try { JSON.parse(input); return input; } catch (e) { /* broken, repair below */ }
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        // Keep an existing escape pair (`\"`, `\\`, `\n`, …) untouched.
        if (ch === '\\') { out += ch + (i + 1 < value.length ? value[i + 1] : ''); i++; continue; }
        if (ch === '"') { out += '\\"'; continue; }
        if (ch.charCodeAt(0) < 0x20) {
            switch (ch) {
                case '\n': out += '\\n'; break;
                case '\r': out += '\\r'; break;
                case '\t': out += '\\t'; break;
                default: out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
            }
            continue;
        }
        out += ch;
    }
    return head + out + tail;
}

// Append the closing braces/brackets a truncated JSON object is missing, but
// only when it is safe: the scan must end outside a string, only closers may
// be missing, and the text must not end mid-token (key/comma/colon). This
// recovers the common "off by one `}`" truncation without a model round.
// Returns null when the text is not a plausible truncated JSON body.
function completeJsonClosers(raw) {
    const input = String(raw || '');
    if (!input || input.trimStart()[0] !== '{') return null;
    const stack = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (escape) { escape = false; continue; }
        if (inString && ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') { stack.push(ch); continue; }
        if (ch === '}' || ch === ']') {
            const open = stack.pop();
            if (!open) return null;
            if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null;
        }
    }
    if (inString) return null;
    if (stack.length === 0) return null;
    if (/[,:]\s*$/.test(input)) return null;
    let out = input;
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
    return out;
}

// Run a brace-matching scan over `text`, tracking JSON string state and
// escapes. `start` is the index of the opening `{`. Returns the index of the
// matching `}`, or -1 if the object never closes within `text`.
//
// The escape/string handling here must match `repairJsonText` exactly: a
// backslash inside a string escapes the *next* character, including another
// backslash. Without this, markup like `"cmd":"echo \\"hi\\""` desyncs
// `inString` and the matching brace is never found.
function findJsonObjectEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
    const objects = [];
    let i = 0;
    while (i < text.length && objects.length < maxObjects) {
        const ch = text[i];
        if (ch !== '{') { i++; continue; }
        const end = findJsonObjectEnd(text, i);
        // A stray, never-closing `{` earlier in the text (e.g. the model
        // writing prose like `{sh ...`) must not discard a later, perfectly
        // valid tool call. Skip this opener and keep scanning instead of
        // aborting the whole extraction. Every object returned is still a
        // genuinely balanced substring; only the search position advances.
        if (end === -1) { i++; continue; }
        objects.push(text.substring(i, end + 1));
        i = end + 1;
    }
    return objects;
}

function buildToolCall(name, args = {}) {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
        if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
        try { parsedArgs = JSON.parse(parsedArgs); } catch (e) { return null; }
    }
    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
    if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null;
    let serialized;
    try { serialized = JSON.stringify(parsedArgs); } catch (e) { return null; }
    if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    return { name: toolName, arguments: serialized };
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let candidate = null;
    if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) {
        candidate = obj.tool_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) {
        candidate = obj.function_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
        if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null;
        candidate = obj.tool_calls[0];
    } else if (allowBare) {
        candidate = obj;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fn = candidate.function && typeof candidate.function === 'object'
        ? candidate.function
        : candidate;
    return buildToolCall(
        fn.name ?? candidate.name,
        fn.arguments ?? candidate.arguments ?? candidate.input ?? {}
    );
}

function parseJsonToolCandidate(raw, label = 'json', options = {}, log = console.log) {
    if (!raw) return null;
    const tryParse = (text, source) => {
        try {
            const parsed = JSON.parse(text);
            const tc = coerceToolCallObject(parsed, options);
            if (tc) {
                // A successful parse clears any earlier probe failure so
                // takeJsonParseError() never reports a stale error for a call
                // that was ultimately understood (e.g. via repairJsonText).
                lastJsonParseError = null;
                log(`[parseToolCall] SUCCESS ${label}${source}: ${tc.name} (args=${tc.arguments.length} chars)`);
                return tc;
            }
        } catch (e) {
            // Capture the real reason for the caller's diagnostics (describeToolMarkup).
            // Do NOT log here: JSON.parse is deliberately attempted speculatively
            // against shell/XML/prose candidates, so a failure is expected and
            // would otherwise flood the logs with meaningless warnings.
            recordJsonParseError(e);
        }
        return null;
    };
    const direct = tryParse(raw, '');
    if (direct) return direct;
    const repaired = repairJsonText(raw);
    if (repaired !== raw) {
        const direct2 = tryParse(repaired, '-repaired');
        if (direct2) return direct2;
    }
    // Second chance: the value contained raw (unescaped) quotes. Only attempt
    // this when the shape still looks like a tool call, so ordinary prose that
    // merely mentions a brace is not rewritten.
    if (!/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(raw)) return null;
    const quotesRepaired = repairUnescapedQuotes(repaired === raw ? raw : repaired);
    if (quotesRepaired !== (repaired === raw ? raw : repaired)) {
        const viaQuotes = tryParse(quotesRepaired, '-quotes-repaired');
        if (viaQuotes) return viaQuotes;
    }
    // Third chance: XML-like keys and adjacent string literals
    // (`{"tool_call":{ id="call_1""name":"read"...}}`). repairJsonText and
    // repairUnescapedQuotes leave the `=` and the missing comma alone, so the
    // object still does not parse. Same guard as above: only rewrite when the
    // shape is a tool call, never ordinary prose.
    if (!/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(raw)) return null;
    // Run the XML-like fix on the control-repaired text, then quote-repair the
    // result: repairUnescapedQuotes mangles the glued `""` before this rule
    // can see it, so order matters. Finally append any missing closers, since
    // this shape often also loses the final brace.
    const xmlBase = repairXmlLikeKeys(repaired);
    if (xmlBase !== repaired) {
        const xmlThenQuotes = repairUnescapedQuotes(xmlBase);
        const viaXml = tryParse(xmlThenQuotes, '-xml-keys-repaired');
        if (viaXml) return viaXml;
        const completed = completeJsonClosers(xmlThenQuotes);
        if (completed) {
            const viaCompleted = tryParse(completed, '-xml-keys-completed');
            if (viaCompleted) return viaCompleted;
        }
    }
    // Fourth chance: a value whose closing quote was dropped right before the
    // object's trailing braces (`"limit":35"}}}`). This desyncs the brace
    // scanner, so no candidate is even extracted; drop the stray quote and
    // retry. Guarded by the same tool-call shape check as above.
    const strayFixed = repairStrayClosingQuote(repaired);
    if (strayFixed !== repaired) {
        const viaStray = tryParse(strayFixed, '-stray-quote-repaired');
        if (viaStray) return viaStray;
    }
    // Fifth chance: a single string argument whose value embeds a nested JSON/JS
    // body escaped one level too few (`{"tool_call":{"name":"bash","arguments":
    // {"command":"node -e '\nconsole.log("hi");\n'"}}}`). The inner quotes close
    // the outer value early, so no candidate is extracted and every other
    // repair is unreachable. Re-escape only that value. Guarded on the same
    // tool-call shape and on the object not already parsing.
    const nestedFixed = repairNestedStringValue(repaired === raw ? raw : repaired);
    if (nestedFixed !== (repaired === raw ? raw : repaired)) {
        const viaNested = tryParse(nestedFixed, '-nested-value-repaired');
        if (viaNested) return viaNested;
    }
    return null;
}

// --- parse diagnostics -----------------------------------------------------
// parseToolCall swallows JSON.parse errors by design (it probes several shapes
// and most failures are expected). To make "parse=no-call" actionable we keep
// the *last* failure around and let recovery.js read it. A module-level slot is
// safe because parsing is synchronous and single-threaded per event-loop tick.
let lastJsonParseError = null;
function recordJsonParseError(e) {
    lastJsonParseError = e && e.message ? e.message : String(e);
}
function takeJsonParseError() {
    const err = lastJsonParseError;
    lastJsonParseError = null;
    return err;
}

// Reset the last JSON.parse diagnostic. parseToolCall() clears it at the start
// of every parse so a stale error is never reported for a call that parsed.
function resetJsonParseError() {
    lastJsonParseError = null;
}

module.exports = {
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
};
