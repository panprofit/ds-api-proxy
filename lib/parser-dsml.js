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
    repairTrailingClosers,
} = require('./json-repair');
const { looksLikeNativeMarker } = require('./parser-native');

const DSML_MARKER_RE = /^([|/]*)\s*(?:DSML|工具调用)\s*([|/]*)\s*/i;

function splitDsmlTagToken(rawToken) {
    let token = String(rawToken || '').trim()

        .replace(/\u2581/g, '_')
        .replace(/[｜丨]/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let hasMarker = false;
    let marker;
    while ((marker = token.match(DSML_MARKER_RE))) {
        hasMarker = true;

        if ((marker[1] + marker[2]).includes('/')) closing = true;
        token = token.substring(marker[0].length).trim();
    }
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    const stray = token.match(/^\|+\s*/);
    if (stray && /^\/?\s*(?:tool|function|calls|invoke|parameter|direct)/i.test(token.substring(stray[0].length))) {
        token = token.substring(stray[0].length);
        if (token.startsWith('/')) {
            closing = true;
            token = token.substring(1).trim();
        }
    }
    return { token, closing, hasMarker };
}

function canonicalizeToolMarkupTag(rawTag) {
    const { token, closing } = splitDsmlTagToken(rawTag);

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

    if (/^\/?function$/i.test(token)) return closing ? '</invoke>' : null;

    const bareAttribute = token.match(/^(function|parameter)\s*=\s*([^\s"']+)$/i);
    if (bareAttribute) {
        const tag = bareAttribute[1].toLowerCase() === 'function' ? 'invoke' : 'parameter';
        return `<${tag} name="${bareAttribute[2]}">`;
    }

    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|tool[\s_-]*call|function[\s_-]*calls|calls|tool[\s_-]*invokes?|tool[\s_-]*params?|invoke|tool[\s_-]*parameters?|parameter)\b([\s\S]*)$/i);
    if (!semantic) {
        const mistypedParameter = !closing && token.match(/^([A-Za-z_][\w.-]*)["']?\s+string\s*=\s*(["'])(true|false)\2\s*$/i);
        if (mistypedParameter) {
            return `<parameter name="${mistypedParameter[1]}" string="${mistypedParameter[3].toLowerCase()}">`;
        }
        return null;
    }
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    let canonicalName = localName;
    if (localName === 'toolcalls' || localName === 'toolcall' || localName === 'functioncalls' || localName === 'calls') canonicalName = 'tool_calls';
    else if (localName === 'toolinvoke' || localName === 'toolinvokes') canonicalName = 'invoke';
    else if (localName === 'toolparam' || localName === 'toolparams' || localName === 'toolparameter' || localName === 'toolparameters') canonicalName = 'parameter';
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

const DSML_SPLIT_TAG_RE = new RegExp('<\\s*(\\/?)\\s*(?:[|\\uFF5C\\u4E28]*\\s*(?:DSML|\\u5DE5\\u5177\\u8C03\\u7528)\\s*[|\\uFF5C\\u4E28]*\\s*)+>([^<>]{0,1024})>', 'gi');

const SPLIT_TAG_NAME_RE = /^\s*(?:tool_calls|tool_call|calls|tool_invokes?|tool_params?|invoke|tool_parameters?|parameter|direct|function)\b/i;

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/\uFF1C/g, '<').replace(/\uFF1E/g, '>')
        .replace(DSML_SPLIT_TAG_RE, (whole, slash, rest) => {
            if (!SPLIT_TAG_NAME_RE.test(rest)) return whole;
            const canonical = canonicalizeToolMarkupTag(slash + rest.trim());
            return canonical || whole;
        });
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
    const quote = `(\\\\?["'])`;
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*${quote}([^"']+)\\1`, 'i'));
    return match ? match[2].replace(/\\\\(["'])/g, '$1') : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;

    let prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart().replace(/\u2581/g, '_');
    if (prefix.startsWith('/')) prefix = prefix.substring(1).trimStart();
    const marker = prefix.match(/^(?:[|｜丨/]*\s*(?:DSML|工具调用)\s*[|｜丨/]*\s*)?/i);
    const afterMarker = prefix.substring(marker[0].length);
    const hasName = /^(?:tool_calls|calls|tool_invokes?|invoke|tool_parameters?|parameter|direct)\b/i.test(afterMarker);

    const nameless = marker[0] && (afterMarker === '' || /^\s*\/?>/.test(afterMarker));

    const bareMarkerAttribute = marker[0] && /^[A-Za-z_][\w.-]*\s*=\s*(["'])[^"']*\1\s*\/?>/.test(afterMarker);
    if (!hasName && !nameless && !bareMarkerAttribute) return null;
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
    const bareAttribute = hasMarker && !closing && !selfClosing
        ? nameToken.match(/^([A-Za-z_][\w.-]*)\s*=\s*(["'])([^"']*)\2\s*$/)
        : null;
    if (bareAttribute) {
        return {
            name: 'parameter',
            attrs: ` name="${bareAttribute[1]}" string="true"`,
            body: bareAttribute[3],
            closing: false,
            selfClosing: false,
            start,
            end: end + 1,
        };
    }
    const rawMatch = nameToken.match(/^(tool_calls|tool_call|calls|tool_invokes?|tool_params?|invoke|tool_parameters?|parameter|direct)\b([\s\S]*)$/i);
    const TAG_ALIASES = { tool_calls: 'tool_calls', tool_call: 'tool_calls', calls: 'tool_calls', tool_invoke: 'invoke', tool_invokes: 'invoke', invoke: 'invoke', tool_param: 'parameter', tool_parameters: 'parameter', tool_parameter: 'parameter', parameter: 'parameter', direct: 'direct' };
    const match = rawMatch && [rawMatch[0], TAG_ALIASES[rawMatch[1].toLowerCase()], rawMatch[2]];
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
        if (tag.invalid) {
            i++;
            continue;
        }
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
        try { value = JSON.parse(rawValue.trim()); } catch (e) {
            const fixed = repairTrailingClosers(rawValue.trim());
            if (fixed === rawValue.trim()) return false;
            try { value = JSON.parse(fixed); } catch (e2) { return false; }
        }
    }
    args[parameterName] = value;
    return true;
}

function findParameterOpening(tags, from) {
    return tags.find(tag => tag.name === 'parameter' && !tag.closing && !tag.selfClosing
        && tag.start >= from && getMarkupAttribute(tag.attrs, 'name'));
}

function unescapeStructuralWhitespace(text) {
    return String(text || '').replace(/\\r\\n|\\n|\\r|\\t/g, ' ');
}

function followsStructuralBoundary(body, from) {
    let i = from;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) return true;
    const tag = readDsmlTagAt(body, i);
    return Boolean(tag && !tag.invalid);
}

function parameterDepthAt(tags, from, to) {
    let depth = 0;
    for (const tag of tags) {
        if (tag.start < from || tag.start >= to || tag.name !== 'parameter') continue;
        if (tag.closing) depth = Math.max(0, depth - 1);
        else if (!tag.selfClosing) depth++;
    }
    return depth;
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
    if (!opening || unescapeStructuralWhitespace(body.substring(i, opening.start)).trim()) return null;

    if (opening.body !== undefined) {
        const nextArgs = { ...args };
        const nextSeen = new Set(seen);
        if (!parseDsmlParameter(opening.attrs, opening.body, nextArgs, nextSeen)) return null;
        return parseDsmlParameterSequence(body, tags, opening.end, nextArgs, nextSeen, count + 1, budget);
    }

    const parameterClose = tags.find(tag => tag.closing && tag.name === 'parameter' && tag.start >= opening.end);
    const genericClose = tags.find(tag => tag.closing && tag.generic && tag.start >= opening.end
        && followsStructuralBoundary(body, tag.end));
    const invokeClose = tags.find(tag => tag.closing && tag.name === 'invoke' && tag.start >= opening.end);
    const closings = [parameterClose, genericClose, invokeClose].filter((tag, index, list) => tag && list.indexOf(tag) === index);
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

function unwrapNestedToolCallWrappers(body) {
    let value = String(body || '');
    for (let depth = 0; depth < 8; depth++) {
        const tags = scanDsmlStructuralTags(value);
        if (!tags) return value;
        let i = 0;
        while (tags[i] && tags[i].name === 'tool_calls' && !tags[i].closing && !tags[i].selfClosing) i++;
        if (i === 0) return value;
        const first = tags[i];
        if (!first) return value;
        const closings = tags.filter(tag => tag.name === 'tool_calls' && tag.closing);
        const closing = closings[closings.length - 1];
        if (!closing) return value;
        if (value.substring(0, tags[0].start).trim() || value.substring(closing.end).trim()) return value;
        value = value.substring(tags[i - 1].end, closing.start);
    }
    return value;
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

        const closing = tags.filter(tag => ((tag.name === 'invoke' || tag.generic) && tag.closing
            && (tag.name === 'invoke' || parameterDepthAt(tags, first.end, tag.start) === 0))
            || (tag.name === 'invoke' && !tag.closing && !tag.selfClosing && tag.start >= first.end && !getMarkupAttribute(tag.attrs, 'name'))).pop()
            ?? scanDsmlStructuralTags(normalized)
                ?.filter(tag => tag.name === 'tool_calls' && tag.closing)
                .pop()
            ?? null;
        if (!closing) return null;
        const closingStart = closing.start >= scope.length ? scope.length : closing.start;
        const rawBody = scope.substring(first.end, closingStart);
        const body = unwrapNestedToolCallWrappers(rawBody);
        const nested = body !== rawBody
            ? parseDsmlToolCall(body, () => {})
            : null;
        const parsed = nested ?? parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), body);
        if (parsed) {
            log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
        if (!getMarkupAttribute(first.attrs, 'name')) {
            const recovered = parseDsmlInvoke('__recovered__', body);
            try {
                const args = JSON.parse(recovered?.arguments || '{}');
                if (args && typeof args.name === 'string' && args.name) {
                    const toolName = args.name;
                    delete args.name;
                    const call = buildToolCall(toolName, args);
                    log(`[parseToolCall] SUCCESS dsml-nameless: ${toolName} (args=${call.arguments.length} chars)`);
                    return call;
                }
            } catch (e) {}
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

function parseDsmlToolCalls(text, log = console.log) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return [];
    const normalized = normalizeToolMarkupTags(text);
    const scope = extractToolCallScope(normalized) ?? normalized;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return [];

    const calls = [];
    let invokeDepth = 0;
    let parameterDepth = 0;
    let current = null;
    for (const tag of tags) {
        if (tag.name === 'parameter' || (tag.generic && tag.closing && (parameterDepth > 0 || invokeDepth === 0))) {
            if (tag.closing) {
                if (parameterDepth > 0) parameterDepth--;
            } else if (!tag.selfClosing) {
                parameterDepth++;
            }
            continue;
        }
        if (parameterDepth > 0) continue;
        if (tag.name !== 'invoke' && !tag.generic) continue;
        if (tag.closing) {
            if (invokeDepth === 0) continue;
            invokeDepth--;
            if (invokeDepth === 0 && current) {
                const parsed = parseDsmlToolCall(scope.substring(current.start, tag.end), log);
                if (parsed) calls.push(parsed);
                current = null;
            }
            continue;
        }
        if (tag.selfClosing) continue;
        if (invokeDepth === 0) current = { start: tag.start };
        invokeDepth++;
    }
    return calls;
}

const INLINE_CODE_SPAN_RE = /(?<!`)`[^`\n]{1,}`(?!`)/g;
function blankInlineCodeSpans(text) {
    return String(text || '').replace(INLINE_CODE_SPAN_RE, (m) => ' '.repeat(m.length));
}

const TOOL_MARKUP_START_PATTERNS = [
    /<\s*[|｜]?\s*\/?\s*[|｜]?\s*tool_call\b/i,
    /[<<][^<>\n]{0,8}[|｜丨]+\s*(?:DSML|工具调用)\s*[|｜丨]+/i,
    /[<<]\s*\/?\s*(?:[|｜丨/]*\s*(?:DSML|工具调用)\s*[|｜丨/]*\s*)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|tool[\s_-]*invokes?|invoke)\b/i,
    /<\|tool[▁_][a-z]+[▁_][a-z]+\|>/i,
    /["'](?:tool_call|function_call|tool_calls)["']\s*:/i,
];

function toolMarkupStartIndex(text) {
    const value = blankInlineCodeSpans(text);
    let at = -1;
    for (const re of TOOL_MARKUP_START_PATTERNS) {
        const pos = value.search(re);
        if (pos !== -1 && (at === -1 || pos < at)) at = pos;
    }
    return at;
}

function looksLikeTaggedToolMarkup(text) {
    return toolMarkupStartIndex(text) !== -1;
}

function looksLikeToolCallMarkup(text) {
    const value = blankInlineCodeSpans(text);

    if (looksLikeNativeMarker(value)) return true;

    if (looksLikeTaggedToolMarkup(value)) return true;

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
    unwrapNestedToolCallWrappers,
    extractToolCallScope,
    parseDsmlToolCall,
    parseDsmlToolCalls,
    looksLikeTaggedToolMarkup,
    looksLikeToolCallMarkup,
    toolMarkupStartIndex,
    blankInlineCodeSpans,
};
