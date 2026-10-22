'use strict';

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
    blankInlineCodeSpans,
} = require('./parser-dsml');
const {
    looksLikeNativeMarker,
    parseNativeToolCalls,
} = require('./parser-native');

function blankFencedBlocks(text) {
    return String(text || '').replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m) => ' '.repeat(m.length));
}

function hasProseOutsideFences(text) {
    const value = String(text || '');
    const blanked = blankFencedBlocks(value);
    return blanked !== value && blanked.trim() !== '';
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
    
    const hasDsml = /<\s*tool_call\b/i.test(probe)
        || (/(?:[|｜]+\s*DSML\s*[|｜]*|[|｜]*\s*DSML\s*[|｜]+)/i.test(probe) && /[<＜]/.test(probe))
        || /[<＜]\s*\/?\s*(?:[|｜/]*\s*DSML\s*[|｜/]*\s*)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(probe);
    
    const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        const tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true }, log);
        if (tc) return tc;
    }
    
    if (looksLikeNativeMarker(probe)) {
        const nativeCall = parseNativeToolCalls(text);
        if (nativeCall) {
            log(`[parseToolCall] SUCCESS native: ${nativeCall.name} (args=${nativeCall.arguments.length} chars)`);
            return nativeCall;
        }
    }
    
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
        const dsml = parseDsmlToolCall(text, log);
        if (dsml) return dsml;
        debugLog(log, `[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed; unparsed text (${text.length} chars): ${JSON.stringify(text.substring(0, MAX_TOOL_MARKUP_CHARS))}`);
        return null;
    }
    
    debugLog(log, `[parseToolCall] No tool call match in ${text.length} chars: ${JSON.stringify(text)}`);
    return null;
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
    looksLikeNativeMarker,
    parseNativeToolCalls,
    blankFencedBlocks,
    hasProseOutsideFences,
    parseToolCall,
    takeJsonParseError,
};
