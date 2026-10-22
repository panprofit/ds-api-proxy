'use strict';

const {
    MAX_TOOL_MARKUP_CHARS,
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_DSML_PARAMETERS,
    MAX_DSML_STRUCTURAL_TAGS,
    MAX_DSML_TAG_CHARS,
} = require('./parser-limits');
const {
    buildToolCall,
    extractBalancedJsonObjects,
} = require('./json-repair');
const { looksLikeNativeMarker } = require('./parser-native');

const DSML_MARKER_RE = /^([|/]*)\s*DSML\s*([|/]*)\s*/i;

function splitDsmlTagToken(rawToken) {
    let token = String(rawToken || '').trim()
        
        .replace(/\u2581/g, '_')
        .replace(/｜/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let hasMarker = false;
    const marker = token.match(DSML_MARKER_RE);
    if (marker) {
        hasMarker = true;
        
        if ((marker[1] + marker[2]).includes('/')) closing = true;
        token = token.substring(marker[0].length);
    }
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    return { token, closing, hasMarker };
}

function canonicalizeToolMarkupTag(rawTag) {
    const { token, closing } = splitDsmlTagToken(rawTag);

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;
    
    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|calls|invoke|parameter)\b([\s\S]*)$/i);
    if (!semantic) return null;
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    const canonicalName = localName === 'toolcalls' || localName === 'functioncalls' || localName === 'calls'
        ? 'tool_calls'
        : localName;
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
    return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
        const canonical = canonicalizeToolMarkupTag(rawTag);
        return canonical || whole;
    });
}

function decodeDsmlValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function decodeDsmlParameterValue(value) {
    const raw = String(value || '');
    const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs, attribute) {
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
    return match ? match[2] : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;
    
    let prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart().replace(/\u2581/g, '_');
    if (prefix.startsWith('/')) prefix = prefix.substring(1).trimStart();
    const marker = prefix.match(/^(?:[|｜/]*\s*DSML\s*[|｜/]*\s*)?/i);
    const afterMarker = prefix.substring(marker[0].length);
    const hasName = /^(?:tool_calls|calls|invoke|parameter|direct)\b/i.test(afterMarker);
    
    const nameless = marker[0] && (afterMarker === '' || /^\s*\/?>/.test(afterMarker));
    if (!hasName && !nameless) return null;
    let quote = null;
    let end = -1;
    const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
    for (let i = start + 1; i < scanEnd; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            end = i;
            break;
        }
    }
    if (end === -1) return { invalid: true };

    const { token, closing, hasMarker } = splitDsmlTagToken(text.substring(start + 1, end));
    let selfClosing = false;
    let nameToken = token;
    if (!closing && nameToken.endsWith('/')) {
        selfClosing = true;
        nameToken = nameToken.substring(0, nameToken.length - 1).trim();
    }
    const match = nameToken.match(/^(tool_calls|calls|invoke|parameter|direct)\b([\s\S]*)$/i);
    if (!match) {
        
        if (hasMarker && closing && !nameToken) {
            return { name: '', generic: true, attrs: '', closing: true, selfClosing: false, start, end: end + 1 };
        }
        return null;
    }
    return {
        name: match[1].toLowerCase() === 'calls' ? 'tool_calls' : match[1].toLowerCase(),
        attrs: closing ? '' : match[2],
        closing,
        selfClosing,
        start,
        end: end + 1,
    };
}

function scanDsmlStructuralTags(text) {
    const tags = [];
    const value = String(text || '');
    for (let i = 0; i < value.length;) {
        if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
            const cdataEnd = value.indexOf(']]>', i + 9);
            if (cdataEnd === -1) return null;
            i = cdataEnd + 3;
            continue;
        }
        if (value[i] !== '<') {
            i++;
            continue;
        }
        const tag = readDsmlTagAt(value, i);
        if (!tag) {
            i++;
            continue;
        }
        if (tag.invalid) return null;
        tags.push(tag);
        if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
        i = tag.end;
    }
    return tags;
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
    const parameterName = getMarkupAttribute(attrs, 'name');
    if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
    seenNames.add(parameterName);
    const stringMode = getMarkupAttribute(attrs, 'string');
    const rawValue = decodeDsmlParameterValue(rawBody);
    if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
    let value = rawValue;
    if (stringMode && stringMode.toLowerCase() === 'false') {
        try { value = JSON.parse(rawValue.trim()); } catch (e) { return false; }
    }
    args[parameterName] = value;
    return true;
}

function findParameterOpening(tags, from) {
    return tags.find(tag => tag.name === 'parameter' && !tag.closing && !tag.selfClosing
        && tag.start >= from && getMarkupAttribute(tag.attrs, 'name'));
}

function parseDsmlParameterSequence(body, tags, cursor, args, seen, count, budget) {
    if (budget.steps-- <= 0) return null;
    let i = cursor;
    
    for (;;) {
        while (i < body.length && /\s/.test(body[i])) i++;
        if (i >= body.length) break;
        const tag = readDsmlTagAt(body, i);
        if (!tag || !tag.closing) break;
        i = tag.end;
    }
    if (i >= body.length) return count > 0 ? { args, seen } : null;
    if (count >= MAX_DSML_PARAMETERS) return null;
    const opening = findParameterOpening(tags, i);
    if (!opening || body.substring(i, opening.start).trim()) return null;

    const closings = tags.filter(tag => tag.closing && tag.start >= opening.end
        
        && !tags.some(other => other.name === 'parameter' && !other.closing && !other.selfClosing
            && other.start >= opening.end && other.start < tag.start
            && getMarkupAttribute(other.attrs, 'name'))
        
        && (tag.name === 'parameter' || tag.generic
            || !tags.some(other => other.name === 'parameter' && other.closing)));
    for (const closing of closings) {
        const nextArgs = { ...args };
        const nextSeen = new Set(seen);
        if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), nextArgs, nextSeen)) continue;
        const parsed = parseDsmlParameterSequence(body, tags, closing.end, nextArgs, nextSeen, count + 1, budget);
        if (parsed) return parsed;
    }
    return null;
}

function parseDsmlInvoke(name, body) {
    const structuralTags = scanDsmlStructuralTags(body);
    if (!structuralTags) return null;
    const parsed = parseDsmlParameterSequence(body, structuralTags, 0, {}, new Set(), 0, { steps: 4096 });
    if (parsed) return buildToolCall(name, parsed.args);

    const decodedBody = decodeDsmlValue(body).trim();
    if (!decodedBody) return buildToolCall(name, {});
    const objects = extractBalancedJsonObjects(decodedBody, 2);
    if (objects.length !== 1 || decodedBody !== objects[0]) return null;
    try { return buildToolCall(name, JSON.parse(objects[0])); }
    catch (e) { return null; }
}

function extractToolCallScope(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags) return null;
    const wrappers = tags.filter(tag => tag.name === 'tool_calls');
    const openings = wrappers.filter(tag => !tag.closing && !tag.selfClosing);
    const closings = wrappers.filter(tag => tag.closing);
    if (openings.length > 0) {
        
        const opening = openings[0];
        const closing = closings.filter(tag => tag.start >= opening.end).pop();
        if (!closing) return null;
        return normalized.substring(opening.end, closing.start);
    }
    if (closings.length > 0) {
        const closing = closings[closings.length - 1];
        const invokeOpenings = tags.filter(tag => tag.name === 'invoke' && !tag.closing && !tag.selfClosing);
        if (invokeOpenings.length > 0) {
            return normalized.substring(invokeOpenings[0].start, closing.start);
        }
    }
    return null;
}

function parseDsmlToolCall(text, log = console.log) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = normalizeToolMarkupTags(text);
    
    const scope = extractToolCallScope(normalized) ?? normalized;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return null;
    
    let firstIndex = 0;
    while (tags[firstIndex] && tags[firstIndex].name === 'tool_calls'
        && !tags[firstIndex].closing && !tags[firstIndex].selfClosing) {
        firstIndex++;
    }
    const first = tags[firstIndex];
    if (!first) return null;
    let prefixEnd = 0;
    for (let i = 0; i < firstIndex; i++) {
        if (scope.substring(prefixEnd, tags[i].start).trim()) return null;
        prefixEnd = tags[i].end;
    }
    if (scope.substring(prefixEnd, first.start).trim()) return null;
    if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
        
        const closing = tags.filter(tag => tag.name === 'invoke' && tag.closing && tag.start >= first.end).pop();
        if (!closing) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start));
        if (parsed) {
            log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }

    if (first.name === 'direct' && !first.closing && !first.selfClosing) {
        if (tags.some((tag, index) => index > firstIndex && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end));
        if (parsed) {
            log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }
    
    if (first.name === 'parameter' && !tags.some(tag => tag.name === 'invoke' && !tag.closing)) {
        const parsed = parseDsmlInvoke('__recovered__', scope.substring(first.start));
        if (parsed) {
            try {
                const args = JSON.parse(parsed.arguments);
                if (args && typeof args.name === 'string' && args.name) {
                    const toolName = args.name;
                    delete args.name;
                    const recovered = buildToolCall(toolName, args);
                    log(`[parseToolCall] SUCCESS dsml-recovered: ${toolName} (args=${recovered.arguments.length} chars)`);
                    return recovered;
                }
            } catch (e) {  }
        }
    }
    return null;
}

const INLINE_CODE_SPAN_RE = /(?<!`)`[^`\n]{1,}`(?!`)/g;
function blankInlineCodeSpans(text) {
    return String(text || '').replace(INLINE_CODE_SPAN_RE, (m) => ' '.repeat(m.length));
}

function looksLikeToolCallMarkup(text) {
    const value = blankInlineCodeSpans(text);
    
    if (looksLikeNativeMarker(value)) return true;
    
    if (/<\s*tool_call\b/i.test(value)) return true;
    if (/[|｜]+\s*DSML\s*[|｜]+/i.test(value) && /[<＜]/.test(value)) return true;
    if (/[<＜]\s*\/?\s*(?:[|｜/]*\s*DSML\s*[|｜/]*\s*)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(value)) {
        return true;
    }
    
    return /["'](?:tool_call|function_call)["']\s*:\s*\{[^}]*["'](?:name|function)["']\s*:/i.test(value)
        || /["']tool_calls["']\s*:\s*\[\s*\{["'](?:function|name|id)["']/i.test(value);
}

module.exports = {
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
};
