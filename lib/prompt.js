'use strict';

const fs = require('fs');
const { truncateForLog } = require('./http');
const config = require('./config');

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

function formatToolCallsBlock(toolCalls) {
    const calls = (toolCalls || []).map(tc => {
        const namespace = resolveToolNamespace(tc)?.name;
        const name = qualifyToolName(tc?.function?.name, namespace);
        let args = tc?.function?.arguments;
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (e) {  }
        }
        if (args === undefined || args === null) args = {};
        return JSON.stringify({ tool_call: { name, arguments: args } });
    });
    return calls.length > 0 ? `\n\n${calls.join('\n\n')}` : '';
}

function formatToolChoiceInstruction(toolChoice) {
    if (toolChoice === 'required') return 'You MUST invoke one of the available tools in this response.';
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.name) {
        return `You MUST invoke the tool "${String(toolChoice.name).replace(/"/g, '\\"')}" in this response.`;
    }
    return '';
}

function formatToolDefinitions(tools, toolChoice = 'auto') {
    if (toolChoice === 'none' || !tools || tools.length === 0) return '';
    const usable = [];
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function && tool.function.name) usable.push(tool);
    }
    if (usable.length === 0) return '';
    let text = '\n\n<tool_calling>\n\n';
    text += '<rules>\n';
    text += '1. You ONLY output the tool request \u2014 you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output \u2014 wait for the actual result\n';
    text += '3. The tool runs on the local server\n';
    text += '4. After the tool executes, the result will be sent to you as a new user/tool message\n';
    text += '5. Never add explanation before or after tool calls when requesting tools\n';
    text += '6. Keep arguments compact. Do not include large file contents unless the tool schema requires it.\n';
    text += '7. Never fabricate tool results: a diff/log/stdout may only come from a real call made in this same turn\n';
    text += '8. Never claim "done"/"committed"/"tests passed" without a fresh real check shown alongside\n';
    text += '9. Plans are future tense; past tense is reserved strictly for facts produced by a real call\n';
    text += '10. If unsure or a call was not made, say so plainly instead of filling the gap\n';
    const choiceInstruction = formatToolChoiceInstruction(toolChoice);
    if (choiceInstruction) text += `11. ${choiceInstruction}\n`;
    text += '</rules>\n';
    text += '\n<tool_schemas>\n\n';
    for (const tool of usable) {
        const fn = tool.function;
        const namespace = resolveToolNamespace(tool);
        text += `\n## ${qualifyToolName(fn.name, namespace?.name)}\n`;
        const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
        text += `${truncateForLog(description, 497, '...')}\n`;
        if (fn.parameters) text += `Parameters: ${JSON.stringify(fn.parameters)}\n`;
    }
    text += '\n</tool_schemas>\n';
    text += '\nREMEMBER: Request tools only with strict JSON format: {"tool_call":{"name":"<function_name>","arguments":{...}}}. Each call is a separate JSON object. Never simulate results.';
    text += '\n\n</tool_calling>';
    return text;
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

function formatMessages(messages, tools, responseFormat, toolChoice = 'auto') {

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
    systemPrompt += formatToolDefinitions(tools, toolChoice);
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
    formatToolDefinitions,
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
