'use strict';

const fs = require('fs');
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

const DSML_TAG = '\uFF5CDSML\uFF5C';

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

function formatDsmlCallsBlock(toolCalls) {
    const invokes = (toolCalls || []).map(tc => {
        const namespace = resolveToolNamespace(tc)?.name;
        return formatDsmlInvoke(qualifyToolName(tc?.function?.name, namespace), tc?.function?.arguments);
    });
    return `\n\n<${DSML_TAG} calls>\n${invokes.join('\n')}\n</${DSML_TAG} calls>`;
}

function formatJsonCall(tc) {
    const namespace = resolveToolNamespace(tc)?.name;
    const name = qualifyToolName(tc?.function?.name, namespace);
    let args = tc?.function?.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) {  }
    }
    if (args === undefined || args === null) args = {};
    const json = JSON.stringify({ name, arguments: args }).replace(/<\/tool_call>/gi, '<\\/tool_call>');
    return `<tool_call>\n${json}\n</tool_call>`;
}

function formatToolCallsBlock(toolCalls, toolCallFormat = 'json') {
    if (toolCallFormat === 'json') {
        return (toolCalls || []).length > 0 ? `\n\n${toolCalls.map(formatJsonCall).join('\n\n')}` : '';
    }
    return formatDsmlCallsBlock(toolCalls);
}

function formatToolChoiceInstruction(toolChoice) {
    if (toolChoice === 'required') return 'You MUST invoke one of the available tools in this response.';
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.name) {
        return `You MUST invoke the tool "${String(toolChoice.name).replace(/"/g, '\\"')}" in this response.`;
    }
    return '';
}

function formatToolDefinitions(tools, toolChoice = 'auto', toolCallFormat = 'json') {

    if (toolChoice === 'none' || !tools || tools.length === 0) return '';
    const schemas = [];
    for (const tool of tools) {
        if (tool.type !== 'function' || !tool.function || !tool.function.name) continue;
        const fn = tool.function;
        const namespace = resolveToolNamespace(tool);
        const schema = { name: qualifyToolName(fn.name, namespace?.name) };
        if (fn.parameters) schema.parameters = fn.parameters;
        schemas.push(JSON.stringify(schema));
    }
    if (schemas.length === 0) return '';
    let text = '\n\n<tool_calling>\n\n';
    if (toolCallFormat === 'json') {
        text += 'You have access to a set of tools to help answer the user\'s question. To invoke a tool, respond with exactly one <tool_call> block containing a JSON object:\n\n';
        text += '<tool_call>\n{"name":"$TOOL_NAME","arguments":{"$PARAMETER_NAME":"$PARAMETER_VALUE"}}\n</tool_call>\n\n';
        text += '`arguments` must be a JSON object. Use native JSON types for numbers, booleans, arrays and objects; string values stay JSON strings.\n\n';
    } else {
        text += 'You have access to a set of tools to help answer the user\'s question. You can invoke tools by writing a "'
            + DSML_TAG + ' calls" block like the following:\n\n';
        text += '<' + DSML_TAG + ' calls>\n';
        text += '<' + DSML_TAG + ' invoke name="$TOOL_NAME">\n';
        text += '<' + DSML_TAG + ' parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</' + DSML_TAG + ' parameter>\n';
        text += '...\n';
        text += '</' + DSML_TAG + ' invoke>\n';
        text += '<' + DSML_TAG + ' invoke name="$TOOL_NAME2">\n';
        text += '...\n';
        text += '</' + DSML_TAG + ' invoke>\n';
        text += '</' + DSML_TAG + ' calls>\n\n';
        text += 'String parameters should be specified as is and set `string="true"`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set `string="false"`.\n\n';
    }
    text += '<rules>\n';
    text += `1. Request exactly ONE tool call per response; output nothing before or after the ${toolCallFormat === 'json' ? '<tool_call> block' : 'calls block'}\n`;
    text += '2. Never fabricate tool results: a "tool_result" block is written by the local gateway and is only ever sent TO you\n';
    text += '3. Never claim "done"/"committed"/"tests passed" without a real tool result from this turn\n';
    text += '4. Keep arguments compact; do not include large file contents unless the schema requires it\n';
    const choiceInstruction = formatToolChoiceInstruction(toolChoice);
    if (choiceInstruction) text += `5. ${choiceInstruction}\n`;
    text += '</rules>\n';
    text += '\n<tool_schemas>\n\n';
    text += schemas.join('\n');
    text += '\n</tool_schemas>\n';
    text += '\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n';
    text += toolCallFormat === 'json'
        ? 'REMEMBER: Request tools only inside a <tool_call> JSON block, one call per response. Never simulate results.'
        : 'REMEMBER: Request tools only with this DSML format, one call per response. Never simulate results.';
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

function formatReasoningEffort(score) {
    if (!Number.isFinite(score) || score <= 0) return '';
    return `Reasoning Effort: ${score} (range 1-100, the higher the value, the more thorough the reasoning)`;
}

function formatResponseLengthLimit(maxWords) {
    if (!Number.isFinite(maxWords) || maxWords <= 0) return '';
    return `Keep your reply within ${maxWords} words. If the content is large, first give a summary of the key points and ask whether to continue, instead of outputting everything at once.`;
}

function formatMessages(messages, tools, responseFormat, toolChoice = 'auto', toolCallFormat = 'json', reasoningEffortScore = null) {

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
    const effortText = formatReasoningEffort(reasoningEffortScore);
    if (effortText) systemPrompt = `${effortText}\n\n${systemPrompt}`;
    systemPrompt += formatToolDefinitions(tools, toolChoice, toolCallFormat);
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
                conversation += `Assistant:${formatToolCallsBlock(msg.tool_calls, toolCallFormat)}\n\n`;
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
