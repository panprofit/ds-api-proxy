'use strict';

const fs = require('fs');
const config = require('./config');

const DSML_TAG = '\uFF5CDSML\uFF5C';

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `<tool_result>\n${toolResultBody(part.content)}\n</tool_result>`;
            if (part.type === 'image_url') return '';
            return part.text || part.content || JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function escapeToolResultClose(text) {
    return String(text || '').replace(/<\/tool_result>/gi, '<\\/tool_result>');
}

function truncateToolResult(text, maxBytes = config.get().maxToolResultBytes) {
    if (!(maxBytes > 0)) return text;
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
    const kept = buf.subarray(0, end).toString('utf8');
    return `${kept}\n\n[tool result truncated: ${buf.length} bytes -> ${end} bytes]`;
}

function toolResultBody(content) {
    return truncateToolResult(escapeToolResultClose(normalizeMessageContent(content)));
}

function resolveToolNamespace(tool) {
    const values = [tool?.namespace, tool?.function?.namespace];
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return { name: value.trim(), description: '' };
        if (value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim()) {
            return { name: value.name.trim(), description: String(value.description || '').trim() };
        }
    }
    return null;
}

function qualifyToolName(name, namespace) {
    const raw = String(name || '').trim();
    if (!raw) return raw;
    const split = raw.indexOf('::');
    if (!namespace) return raw;
    const localName = split === -1 ? raw : raw.substring(split + 2);
    return `${namespace}::${localName}`;
}

function toolQualifiedName(tool) {
    const namespace = resolveToolNamespace(tool);
    return qualifyToolName(tool?.function?.name, namespace?.name);
}

function escapeDsmlText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeDsmlAttribute(value) {
    return escapeDsmlText(value).replace(/"/g, '&quot;');
}

function formatDsmlParameter(name, value) {
    const isString = typeof value === 'string';
    const body = escapeDsmlText(isString ? value : JSON.stringify(value));
    return `<${DSML_TAG} parameter name="${escapeDsmlAttribute(name)}" string="${isString ? 'true' : 'false'}">${body}</${DSML_TAG} parameter>`;
}

function formatDsmlInvoke(name, args) {
    let parsed = args;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { parsed = { arguments: parsed }; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = { arguments: parsed };
    const parameters = Object.entries(parsed).map(([key, value]) => formatDsmlParameter(key, value));
    return `<${DSML_TAG} invoke name="${escapeDsmlAttribute(name)}">\n${parameters.join('\n')}\n</${DSML_TAG} invoke>`;
}

function formatToolCallsBlock(toolCalls) {
    const invokes = (toolCalls || []).map(tc => {
        const namespace = resolveToolNamespace(tc)?.name;
        return formatDsmlInvoke(qualifyToolName(tc?.function?.name, namespace), tc?.function?.arguments);
    });
    return invokes.length > 0 ? `\n\n<${DSML_TAG} calls>\n${invokes.join('\n')}\n</${DSML_TAG} calls>` : '';
}

function composePrompt(systemPrompt, conversationPrompt) {
    const system = String(systemPrompt || '').trim();
    const conversation = String(conversationPrompt || '').trim();
    return system ? `${system}\n\n${conversation}` : conversation;
}

function appendPromptInstruction(promptText, instruction) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    return [promptText, suffix].join('');
}

function isSystemRole(role) {
    return role === 'system' || role === 'developer';
}

function messageFingerprint(msg) {
    const role = String(msg?.role || '');
    const content = normalizeMessageContent(msg?.content);
    return `${role}\u0000${content}`;
}

function turnKey(msg, occurrence) {
    return `${messageFingerprint(msg)}\u0000${occurrence}`;
}

function computeTurnKeys(messages) {
    const seen = new Map();
    const out = [];
    let seenNonSystem = false;
    for (const msg of messages || []) {
        if (!msg) continue;
        if (isSystemRole(msg.role)) {
            if (!seenNonSystem) continue;
        } else {
            seenNonSystem = true;
            if (msg.role !== 'user' && msg.role !== 'tool') continue;
        }
        if (!msg.content) continue;
        const base = messageFingerprint(msg);
        const occurrence = seen.get(base) || 0;
        seen.set(base, occurrence + 1);
        out.push({ msg, key: turnKey(msg, occurrence) });
    }
    return out;
}

const cachedTurnKeys = new WeakMap();

function collectPendingTurns(messages, session) {
    const sent = session.sentKeys instanceof Set ? session.sentKeys : (session.sentKeys = new Set());
    const pending = [];
    for (const { msg, key } of computeTurnKeys(messages)) {
        cachedTurnKeys.set(msg, key);
        if (sent.has(key)) continue;
        pending.push(msg);
    }
    return pending;
}

function markTurnsSent(session, turns) {
    if (!(session.sentKeys instanceof Set)) session.sentKeys = new Set();

    const computed = new Map();
    for (const { msg, key } of computeTurnKeys(turns)) computed.set(msg, key);
    for (const msg of turns || []) {
        if (!msg) continue;
        if (msg.role !== 'user' && msg.role !== 'tool' && msg.role !== 'system') continue;
        const key = cachedTurnKeys.get(msg) || computed.get(msg);

        if (key) session.sentKeys.add(key);
    }
}

function renderTurn(msg) {
    if (!msg || !msg.content) return '';
    if (msg.role === 'user') {
        return `User: ${normalizeMessageContent(msg.content)}\n\n`;
    }
    if (isSystemRole(msg.role)) {
        return `System: ${normalizeMessageContent(msg.content)}\n\n`;
    }
    if (msg.role === 'tool') {
        return `<tool_result>\n${toolResultBody(msg.content)}\n</tool_result>\n\n`;
    }
    return '';
}

function formatPendingTurns(turns) {
    let conversation = '';
    for (const msg of turns || []) conversation += renderTurn(msg);
    return conversation.trim();
}

function formatResponseFormat(responseFormat) {
    if (!responseFormat || typeof responseFormat !== 'object') return '';
    const type = String(responseFormat.type || '');
    if (type === 'json_object') {
        return formatResponseFormatSchema('{"type": "json_object"}');
    }
    if (type === 'json_schema') {
        const schema = responseFormat.json_schema?.schema;
        if (!schema) return 'Respond in JSON format.';
        return formatResponseFormatSchema(JSON.stringify(schema));
    }
    if (type === 'text') return '';
    return type ? `Respond in ${type} format.` : '';
}

function formatResponseFormatSchema(schemaText) {
    return `## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${schemaText}`;
}

function formatResponseLengthLimit(maxWords) {
    if (!Number.isFinite(maxWords) || maxWords <= 0) return '';
    return `Keep your reply within ${maxWords} words. If the content is large, first give a summary of the key points and ask whether to continue, instead of outputting everything at once.`;
}

function formatMessages(messages, tools, responseFormat) {

    const systemParts = [];
    let seenNonSystem = false;
    for (const msg of messages) {
        if (!msg) continue;
        if (!isSystemRole(msg.role)) {
            seenNonSystem = true;
            continue;
        }
        if (!seenNonSystem && msg.content) {
            systemParts.push(normalizeMessageContent(msg.content));
        }
    }
    let systemPrompt = systemParts.join('\n\n');
    const formatText = formatResponseFormat(responseFormat);
    if (formatText) systemPrompt += `\n\n${formatText}`;
    const lengthText = formatResponseLengthLimit(config.get().maxResponseWords);
    if (lengthText) systemPrompt += `\n\n${lengthText}`;

    let conversation = '';
    let sawNonSystem = false;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;
        if (isSystemRole(msg.role)) {
            if (sawNonSystem) conversation += renderTurn(msg);
            continue;
        }
        sawNonSystem = true;
        if (msg.role === 'user' || msg.role === 'tool') {
            conversation += renderTurn(msg);
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                conversation += `Assistant:${formatToolCallsBlock(msg.tool_calls)}\n\n`;
            } else if (msg.content) {
                conversation += `Assistant: ${normalizeMessageContent(msg.content)}\n\n`;
            }
        }
    }
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

function isImagePath(filePath) {
    return typeof filePath === 'string'
        && filePath.startsWith('/')
        && /\.(?:png|jpg|jpeg|webp|gif)$/i.test(filePath);
}

function collectStructuredPaths(value, out) {
    if (typeof value === 'string') {
        if (isImagePath(value)) out.add(value);
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) collectStructuredPaths(item, out);
        return;
    }
    const direct = value.screenshot_path || value.path;
    if (isImagePath(direct)) out.add(direct);
    if (value.media !== undefined) collectStructuredPaths(value.media, out);
}

function extractScreenshotPaths(messages, existsSync = fs.existsSync) {
    const found = new Set();
    for (const msg of messages || []) {

        if (!msg || msg.role !== 'tool') continue;
        if (typeof msg.content === 'string' && msg.content) {
            let parsed = null;
            try { parsed = JSON.parse(msg.content); } catch (e) {  }
            if (parsed) collectStructuredPaths(parsed, found);
        } else if (msg.content && typeof msg.content === 'object') {
            collectStructuredPaths(msg.content, found);
        }
        if (msg.media !== undefined) collectStructuredPaths(msg.media, found);
    }
    const paths = [];
    for (const filePath of found) {
        if (existsSync(filePath)) paths.push(`MEDIA:${filePath}`);
    }
    return paths;
}

module.exports = {
    normalizeMessageContent,
    resolveToolNamespace,
    qualifyToolName,
    toolQualifiedName,
    composePrompt,
    appendPromptInstruction,
    messageFingerprint,
    collectPendingTurns,
    markTurnsSent,
    formatPendingTurns,
    renderTurn,
    formatMessages,
    formatResponseFormat,
    formatResponseLengthLimit,
    extractScreenshotPaths,
};
