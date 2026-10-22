'use strict';

const {
    MAX_TOOL_ARGUMENT_CHARS,
    MAX_TOOL_JSON_CANDIDATES,
} = require('./parser-limits');
const { debugLog } = require('./debug');

function repairJsonText(raw) {
    const input = String(raw || '');
    if (!input) return input;
    let out = '';
    let inString = false;
    let escape = false;
    
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
            
            if (ch !== '}' && ch !== ']') out += ',';
            pendingComma = false;
        }
        out += ch;
    }
    if (pendingComma) out += ',';
    return out;
}

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
                
                out += '\\"';
                changed = true;
            }
            continue;
        }
        out += ch;
    }
    return changed ? out : input;
}

function repairXmlLikeKeys(raw) {
    const input = String(raw || '');
    if (!input) return input;
    let out = input.replace(/\b([A-Za-z_]\w*)\s*=\s*"/g, '"$1":"');
    out = out.replace(/"(\s*)"(?=[A-Za-z_]\w*"\s*:)/g, '",$1"');
    
    out = out.replace(/"(\s+)([A-Za-z_]\w*)\s*:(?=\s*(?:[{["\d-]|true\b|false\b|null\b))/g, '",$1"$2":');
    return out === input ? input : out;
}

function splitConcatenatedToolCalls(raw) {
    const input = String(raw || '');
    if (!input) return input;
    const parts = input.split(/}\}\s*(?={"tool_call")/);
    if (parts.length < 2) return input;
    const repaired = [];
    for (let i = 0; i < parts.length; i++) {
        let part = parts[i];
        
        if (i < parts.length - 1) part += '}';
        const completed = completeJsonClosers(part) ?? part;
        try { JSON.parse(completed); } catch (e) { return input; }
        repaired.push(completed);
    }
    return repaired.join(',');
}

function repairStrayClosingQuote(raw) {
    const input = String(raw || '');
    if (!input) return input;
    if (!/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(input)) return input;
    const quoteRe = /"/g;
    let match;
    while ((match = quoteRe.exec(input)) !== null) {
        const i = match.index;
        
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

function repairNestedStringValue(raw) {
    const input = String(raw || '');
    if (!input) return input;
    const match = input.match(/^(\{"tool_call":\{"name":"([^"]+)","arguments":\{"([^"]+)":")([\s\S]*)("\}\}\})$/);
    if (!match) return input;
    const [, head, , , value, tail] = match;
    
    try { JSON.parse(input); return input; } catch (e) {  }
    let out = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        
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
    
    const input = String(text ?? '');
    const objects = [];
    let i = 0;
    while (i < input.length && objects.length < maxObjects) {
        const ch = input[i];
        if (ch !== '{') { i++; continue; }
        const end = findJsonObjectEnd(input, i);
        
        if (end === -1) { i++; continue; }
        objects.push(input.substring(i, end + 1));
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
                
                lastJsonParseError = null;
                log(`[parseToolCall] SUCCESS ${label}${source}: ${tc.name} (args=${tc.arguments.length} chars)`);
                return tc;
            }
        } catch (e) {
            
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
    
    if (!/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(raw)) return null;
    const quotesRepaired = repairUnescapedQuotes(repaired === raw ? raw : repaired);
    if (quotesRepaired !== (repaired === raw ? raw : repaired)) {
        const viaQuotes = tryParse(quotesRepaired, '-quotes-repaired');
        if (viaQuotes) return viaQuotes;
    }
    
    if (!/["'](?:tool_call|function_call|tool_calls)["']\s*:/.test(raw)) return null;
    
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
    
    const strayFixed = repairStrayClosingQuote(repaired);
    if (strayFixed !== repaired) {
        const viaStray = tryParse(strayFixed, '-stray-quote-repaired');
        if (viaStray) return viaStray;
    }
    
    const nestedFixed = repairNestedStringValue(repaired === raw ? raw : repaired);
    if (nestedFixed !== (repaired === raw ? raw : repaired)) {
        const viaNested = tryParse(nestedFixed, '-nested-value-repaired');
        if (viaNested) return viaNested;
    }
    
    debugLog(console.log, `[parseJsonToolCandidate] FAILED ${label}: len=${raw.length} jsonErr=${lastJsonParseError ?? 'none'} head=${JSON.stringify(raw.slice(0, 120))}`);
    return null;
}

let lastJsonParseError = null;
function recordJsonParseError(e) {
    lastJsonParseError = e && e.message ? e.message : String(e);
}
function takeJsonParseError() {
    const err = lastJsonParseError;
    lastJsonParseError = null;
    return err;
}

function resetJsonParseError() {
    lastJsonParseError = null;
}

module.exports = {
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
