'use strict';

const { debugLogLazy } = require('./debug');
const {
    MAX_TOOL_MARKUP_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
    MAX_DSML_PARAMETERS,
    MAX_DSML_STRUCTURAL_TAGS,
    MAX_DSML_TAG_CHARS,
} = require('./parser-limits');
const {
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
    coerceToolCallList,
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
    parseDsmlToolCalls,
    looksLikeTaggedToolMarkup,
    looksLikeToolCallMarkup,
    toolMarkupStartIndex,
    blankInlineCodeSpans,
} = require('./parser-dsml');
const {
    looksLikeNativeMarker,
    parseNativeToolCalls,
    parseNativeToolCallList,
} = require('./parser-native');

function blankFencedBlocks(text) {
    return String(text || '').replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m) => ' '.repeat(m.length));
}

function hasProseOutsideFences(text) {
    const value = String(text || '');
    const blanked = blankFencedBlocks(value);
    return blanked !== value && blanked.trim() !== '';
}

const WRAPPED_TOOL_TAG_RE = /<\s*([A-Za-z_][\w.:-]{0,127})((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/g;

const WRAPPED_ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

const WRAPPED_TOOL_STRUCTURAL = new Set([
    'tool_calls', 'tool_call', 'tool_invoke', 'tool_invokes', 'tool',
    'invoke', 'parameter', 'direct', 'function_calls', 'function_call', 'function',
]);

const WRAPPED_TOOL_NAMES = new Set([
    'bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls', 'find', 'cat', 'sed', 'awk',
    'tool', 'execute', 'run', 'search', 'fetch', 'web_search', 'web_fetch', 'todo', 'list',
]);

function parseWrappedToolCalls(text) {
    const calls = [];
    let match;
    WRAPPED_TOOL_TAG_RE.lastIndex = 0;
    while ((match = WRAPPED_TOOL_TAG_RE.exec(text)) !== null) {
        const name = match[1];
        if (WRAPPED_TOOL_STRUCTURAL.has(name.toLowerCase())) continue;
        const isAssistant = name.toLowerCase() === 'assistant';
        if (!isAssistant && !WRAPPED_TOOL_NAMES.has(name.toLowerCase())) continue;
        const attrArgs = {};
        for (const attr of String(match[2] || '').matchAll(WRAPPED_ATTR_RE)) {
            attrArgs[attr[1]] = attr[2] ?? attr[3] ?? attr[4];
        }
        const body = match[3].trim();
        if (!body && !Object.keys(attrArgs).length) continue;
        if (isAssistant && (typeof attrArgs.to !== 'string' || !attrArgs.to.trim())) continue;
        const toolName = isAssistant ? attrArgs.to : name;
        delete attrArgs.to;
        const parsedBody = body ? parseDsmlInvoke(name, body) : null;
        const tc = parsedBody
            ? buildToolCall(toolName, { ...attrArgs, ...JSON.parse(parsedBody.arguments) })
            : buildToolCall(toolName, { ...attrArgs, command: body });
        if (tc) calls.push(tc);
    }
    return calls;
}

const XML_TOOL_CALL_OPEN = '<\\s*[|｜]?\\s*tool_call\\b[^<>]*>';
const XML_TOOL_CALL_CLOSE = '<\\s*(?:\\/\\s*[|｜]?|[|｜]\\s*\\/)\\s*tool_call\\b[^<>]*>';
const XML_TOOL_CALL_SOURCE = `(?:${XML_TOOL_CALL_OPEN})([\\s\\S]*?)(?:${XML_TOOL_CALL_CLOSE})`;

function parseXmlToolCalls(text, log) {
    const calls = [];
    const re = new RegExp(XML_TOOL_CALL_SOURCE, 'gi');
    let match;
    while ((match = re.exec(text)) !== null) {
        const tc = parseJsonToolCandidate(match[1].trim(), 'xml', { allowBare: true }, log);
        if (tc) calls.push(tc);
    }
    return calls;
}

function parseToolCall(text, log = console.log) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }
    resetJsonParseError();

    if (hasProseOutsideFences(text)) text = blankFencedBlocks(text);

    const probe = blankInlineCodeSpans(text);

    const hasDsml = looksLikeTaggedToolMarkup(probe);

    const xmlCalls = parseXmlToolCalls(text, log);
    if (xmlCalls.length > 0) return xmlCalls[0];

    const wrapped = parseWrappedToolCalls(text);
    if (wrapped.length > 0) {
        log(`[parseToolCall] SUCCESS wrapped-tag: ${wrapped[0].name} (args=${wrapped[0].arguments.length} chars)`);
        return wrapped[0];
    }

    if (looksLikeNativeMarker(probe)) {
        const nativeCall = parseNativeToolCalls(text);
        if (nativeCall) {
            log(`[parseToolCall] SUCCESS native: ${nativeCall.name} (args=${nativeCall.arguments.length} chars)`);
            return nativeCall;
        }
    }

    const fenceRe = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        const lang = String(fence[1] || '').trim().toLowerCase();
        const body = fence[2].trim();
        if (!body) continue;
        if (lang && lang !== 'json' && lang !== 'tool_call' && lang !== 'tool') continue;
        const tc = parseJsonToolCandidate(body, 'fenced', {}, log);
        if (tc) return tc;

        if (body[0] === '"') {
            try {
                const decoded = JSON.parse(body);
                if (typeof decoded === 'string' && decoded.trim()) {
                    const tc2 = parseJsonToolCandidate(decoded.trim(), 'fenced-decoded', {}, log);
                    if (tc2) return tc2;
                }
            } catch (e) {  }
        }
    }

    for (const rawJson of extractBalancedJsonObjects(text)) {
        const tc = parseJsonToolCandidate(rawJson, 'inline', {}, log);
        if (tc) return tc;
    }

    const controlRepaired = repairJsonText(text);
    const quoteRepaired = repairUnescapedQuotes(controlRepaired);
    if (quoteRepaired !== text) {
        for (const rawJson of extractBalancedJsonObjects(quoteRepaired)) {
            const tc = parseJsonToolCandidate(rawJson, 'inline-quotes-repaired', {}, log);
            if (tc) return tc;
        }
    }

    if (/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(text)) {
        const xmlRepaired = repairXmlLikeKeys(controlRepaired);
        if (xmlRepaired !== controlRepaired) {
            const xmlThenQuotes = repairUnescapedQuotes(xmlRepaired);
            for (const rawJson of extractBalancedJsonObjects(xmlThenQuotes)) {
                const tc = parseJsonToolCandidate(rawJson, 'inline-xml-keys-repaired', {}, log);
                if (tc) return tc;
            }

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

    const strayRepaired = repairStrayClosingQuote(controlRepaired);
    if (strayRepaired !== controlRepaired) {
        for (const rawJson of extractBalancedJsonObjects(strayRepaired)) {
            const tc = parseJsonToolCandidate(rawJson, 'inline-stray-quote-repaired', {}, log);
            if (tc) return tc;
        }
    }

    const nestedRepaired = repairNestedStringValue(controlRepaired);
    if (nestedRepaired !== controlRepaired) {
        for (const rawJson of extractBalancedJsonObjects(nestedRepaired)) {
            const tc = parseJsonToolCandidate(rawJson, 'inline-nested-value-repaired', {}, log);
            if (tc) return tc;
        }
    }

    if (hasDsml) {
        const dsml = parseDsmlToolCalls(text, log)[0] ?? parseDsmlToolCall(text, log);
        if (dsml) return dsml;
        debugLogLazy(log, () => `[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed; unparsed text (${text.length} chars): ${JSON.stringify(text.substring(0, MAX_TOOL_MARKUP_CHARS))}`);
        return null;
    }

    return null;
}

function parseInlineToolCalls(text, log) {
    const calls = [];
    for (const rawJson of extractBalancedJsonObjects(text)) {
        const tc = parseJsonToolCandidate(rawJson, 'inline', {}, log);
        if (tc) {
            calls.push(tc);
            continue;
        }
        try {
            const list = coerceToolCallList(JSON.parse(rawJson));
            if (list) calls.push(...list);
        } catch (e) {  }
    }
    return calls;
}

function parseToolCalls(text, log = console.log) {
    if (!text || typeof text !== 'string') return [];
    if (text.length > MAX_TOOL_MARKUP_CHARS) return [];
    if (hasProseOutsideFences(text)) text = blankFencedBlocks(text);
    const probe = blankInlineCodeSpans(text);
    const xmlCalls = parseXmlToolCalls(text, log);
    if (xmlCalls.length > 0) return xmlCalls;
    if (looksLikeTaggedToolMarkup(probe)) {
        const calls = parseDsmlToolCalls(text, log);
        if (calls && calls.length > 0) return calls;
    }
    const wrapped = parseWrappedToolCalls(text);
    if (wrapped.length > 0) return wrapped;
    if (looksLikeNativeMarker(probe)) {
        const calls = parseNativeToolCallList(text);
        if (calls && calls.length > 0) return calls;
    }
    const inline = parseInlineToolCalls(text, log);
    if (inline.length > 0) return inline;
    const single = parseToolCall(text, log);
    return single ? [single] : [];
}

function stripToolCallMarkup(text) {
    const fenced = [];
    const inline = [];
    const masked = String(text || '').replace(/```[^\n`]*\n?[\s\S]*?```/g, (m) => {
        fenced.push(m);
        return `\uE000FENCE${fenced.length - 1}\uE000`;
    }).replace(/(?<!`)`[^`\n]{1,}`(?!`)/g, (m) => {
        inline.push(m);
        return `\uE000CODE${inline.length - 1}\uE000`;
    });
    const out = normalizeToolMarkupTags(masked)
        .replace(/<\s*([A-Za-z_][\w.:-]{0,127})(?:\s[^<>]*)?>[\s\S]*?<\s*\/\s*\1\s*>/g, (m, name) => {
            const lower = name.toLowerCase();
            return WRAPPED_TOOL_STRUCTURAL.has(lower) ? m : (WRAPPED_TOOL_NAMES.has(lower) || lower === 'assistant' ? ' ' : m);
        })
        .replace(/<\/?(?:tool_calls|invoke|parameter|direct)\b[\s\S]*?(?:<\/\s*(?:tool_calls|invoke|parameter)\s*>|$)/gi, '')
        .replace(/<\/?(?:tool_calls|invoke|parameter|direct)\b[^<>]*>/gi, '')
        .replace(/\{\s*["'](?:tool_calls?|function_call)["']\s*:[\s\S]*$/, '')
        .replace(/<\s*\/?\s*(?:[|\uFF5C\u4E28]*\s*(?:DSML|\u5DE5\u5177\u8C03\u7528)\s*[|\uFF5C\u4E28]*\s*)+>/gi, '');
    return out.replace(/\uE000CODE(\d+)\uE000/g, (m, idx) => inline[Number(idx)])
        .replace(/\uE000FENCE(\d+)\uE000/g, (m, idx) => fenced[Number(idx)])
        .replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
    MAX_TOOL_MARKUP_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
    MAX_DSML_PARAMETERS,
    MAX_DSML_STRUCTURAL_TAGS,
    MAX_DSML_TAG_CHARS,
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
    coerceToolCallList,
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
    parseDsmlToolCalls,
    looksLikeToolCallMarkup,
    toolMarkupStartIndex,
    looksLikeNativeMarker,
    parseNativeToolCalls,
    parseNativeToolCallList,
    blankFencedBlocks,
    hasProseOutsideFences,
    parseToolCall,
    parseToolCalls,
    stripToolCallMarkup,
    takeJsonParseError,
};
