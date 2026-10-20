'use strict';
// Prompt / conversation formatting: tool definitions, message rendering,
// incremental-turn bookkeeping and screenshot-path extraction.
// This domain can evolve independently of the HTTP/SSE/response helpers.

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

// A tool result is gateway-authored text inside an XML-like envelope, so a
// literal `</tool_result>` in the output would close the envelope early and
// turn the rest of the result into model-visible conversation text.
function escapeToolResultClose(text) {
    return String(text || '').replace(/<\/tool_result>/gi, '<\\/tool_result>');
}

// Cap one tool result before it enters the prompt: a single verbose command
// output can otherwise dwarf the conversation and burn the upstream context /
// throughput budget. Truncate on a UTF-8 boundary so the prompt stays valid.
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

// DeepSeek V4.1 native DSML tool grammar. Tags use the fullwidth pipe
// (U+FF5C) exactly as the model's chat template renders them; the parser
// folds it back to ASCII '|'. V4.1 also puts a leading space before the tag
// name (`<｜DSML｜ calls>`, `<｜DSML｜ invoke>`), unlike V4's `tool_calls`.
const DSML_TAG = '\uFF5CDSML\uFF5C';

// Bodies and attribute values are entity-escaped because the parser decodes
// entities before JSON.parse -- escaping here makes arguments round-trip
// byte-exact even when a value contains '&', '<' or '>'.
function escapeDsmlText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeDsmlAttribute(value) {
    return escapeDsmlText(value).replace(/"/g, '&quot;');
}

// One parameter element: strings go in verbatim with string="true", every
// other type is JSON-encoded with string="false" (the native template rule).
function formatDsmlParameter(name, value) {
    const isString = typeof value === 'string';
    const body = escapeDsmlText(isString ? value : JSON.stringify(value));
    return `<${DSML_TAG} parameter name="${escapeDsmlAttribute(name)}" string="${isString ? 'true' : 'false'}">${body}</${DSML_TAG} parameter>`;
}

// One invoke element. `args` is the OpenAI arguments JSON string; each object
// key becomes a parameter. Unparseable arguments fall back to a single raw
// `arguments` parameter, mirroring the native template's non-mapping branch.
function formatDsmlInvoke(name, args) {
    let parsed = args;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { parsed = { arguments: parsed }; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = { arguments: parsed };
    const parameters = Object.entries(parsed).map(([key, value]) => formatDsmlParameter(key, value));
    return `<${DSML_TAG} invoke name="${escapeDsmlAttribute(name)}">\n${parameters.join('\n')}\n</${DSML_TAG} invoke>`;
}

// A namespace may sit either beside `function` or inside it, as a string or
// `{ name, description }`. Returns the normalized `{ name, description }` or
// null when the tool has none.
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

// `search::lookup` is the wire form of a namespaced tool. A fully-qualified
// name is accepted as input too; an explicit namespace replaces any prefix.
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

// A whole calls block, used to render assistant tool_calls in the conversation
// history so the few-shot examples match the requested output format.
function formatDsmlCallsBlock(toolCalls) {
    const invokes = (toolCalls || []).map(tc => {
        const namespace = resolveToolNamespace(tc)?.name;
        return formatDsmlInvoke(qualifyToolName(tc?.function?.name, namespace), tc?.function?.arguments);
    });
    return `\n\n<${DSML_TAG} calls>\n${invokes.join('\n')}\n</${DSML_TAG} calls>`;
}

// Tools are described with the model's native DSML grammar (V4.x chat
// template). The strict-JSON instruction this proxy used to send fought the
// model's trained prior and was the main source of malformed markup.
function formatToolChoiceInstruction(toolChoice) {
    if (toolChoice === 'required') return 'You MUST invoke one of the available tools in this response.';
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.name) {
        return `You MUST invoke the tool "${String(toolChoice.name).replace(/"/g, '\\"')}" in this response.`;
    }
    return '';
}

function formatToolDefinitions(tools, toolChoice = 'auto') {
    // tool_choice=none: do not advertise tools at all, so the model has no
    // schema to call and the response stays plain text.
    if (toolChoice === 'none' || !tools || tools.length === 0) return '';
    const schemas = [];
    for (const tool of tools) {
        if (tool.type !== 'function' || !tool.function || !tool.function.name) continue;
        const fn = tool.function;
        const namespace = resolveToolNamespace(tool);
        const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
        const namespaceDescription = namespace?.description || '';
        const schema = { name: qualifyToolName(fn.name, namespace?.name) };
        const combinedDescription = [namespaceDescription, description].filter(Boolean).join('\n');
        if (combinedDescription) schema.description = truncateForLog(combinedDescription, 497, '...');
        if (fn.parameters) schema.parameters = fn.parameters;
        schemas.push(JSON.stringify(schema));
    }
    if (schemas.length === 0) return '';
    let text = '\n\n## Tools\n\n';
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
    text += 'RULES:\n';
    text += '1. Request exactly ONE tool call per response; output nothing before or after the calls block\n';
    text += '2. Never fabricate tool results: a "tool_result" block is written by the local gateway and is only ever sent TO you\n';
    text += '3. Never claim "done"/"committed"/"tests passed" without a real tool result from this turn\n';
    text += '4. Keep arguments compact; do not include large file contents unless the schema requires it\n';
    const choiceInstruction = formatToolChoiceInstruction(toolChoice);
    if (choiceInstruction) text += `5. ${choiceInstruction}\n`;
    text += '\n### Available Tool Schemas\n\n';
    text += schemas.join('\n');
    text += '\n\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n';
    text += 'REMEMBER: Request tools only with this DSML format, one call per response. Never simulate results.';
    return text;
}

// Compose the final upstream prompt from an optional system prompt and the
// conversation. The full conversation always arrives in the request, so no
// separately stored history is needed.
function composePrompt(systemPrompt, conversationPrompt) {
    const system = String(systemPrompt || '').trim();
    const conversation = String(conversationPrompt || '').trim();
    return system ? `${system}\n\n${conversation}` : conversation;
}

function appendPromptInstruction(promptText, instruction) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    return [promptText, suffix].join('');
}

// Stable fingerprint for a user message or tool result. Used to avoid
// re-sending a turn that was already forwarded to the upstream session.
// NOTE: this is only the *base* (role + content); the dedup key used by
// collectPendingTurns/markTurnsSent appends an occurrence index so two
// identical turns in one conversation do not collapse into one.
function messageFingerprint(msg) {
    const role = String(msg?.role || '');
    const content = normalizeMessageContent(msg?.content);
    return `${role}\u0000${content}`;
}

// Dedup key for a turn: the base fingerprint plus how many times that exact
// role+content pair already appeared earlier in THIS list. Without the
// occurrence suffix, a user sending the same text twice (or running the same
// command twice, producing two identical tool results) would have the second
// turn silently dropped as "already sent".
function turnKey(msg, occurrence) {
    return `${messageFingerprint(msg)}\u0000${occurrence}`;
}

// Enumerate the user/tool turns (with content) of `messages` in order,
// pairing each with its occurrence-aware dedup key. `system` messages are
// included only when they appear after the first non-system turn: a leading
// system prompt travels with the session's first call, while a
// mid-conversation system message is a turn in its own right (V4.1 semantics)
// and must be forwarded on later calls too.
function computeTurnKeys(messages) {
    const seen = new Map();
    const out = [];
    let seenNonSystem = false;
    for (const msg of messages || []) {
        if (!msg) continue;
        if (msg.role === 'system') {
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

// Keys computed for the message objects of the last collectPendingTurns() call.
// markTurnsSent() is also called with a *subset* (the pending turns), where
// recomputing occurrence indices from the subset alone would disagree with the
// full-conversation indices; caching the key on the message keeps both paths in
// sync. A WeakMap avoids retaining messages after the request ends.
const cachedTurnKeys = new WeakMap();

// Collect every not-yet-forwarded turn (user, tool, or mid-conversation
// system) in conversation order.
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
    // Compute the occurrence-aware keys for any message not already cached by
    // collectPendingTurns (the fresh-session path marks the full message list).
    const computed = new Map();
    for (const { msg, key } of computeTurnKeys(turns)) computed.set(msg, key);
    for (const msg of turns || []) {
        if (!msg) continue;
        if (msg.role !== 'user' && msg.role !== 'tool' && msg.role !== 'system') continue;
        const key = cachedTurnKeys.get(msg) || computed.get(msg);
        // A leading system prompt is not a turn: computeTurnKeys() omits it, so
        // no key exists and it must not be marked as sent.
        if (key) session.sentKeys.add(key);
    }
}

// Render one user/tool turn (or a mid-conversation system message), or '' for
// any other role or empty content. Both formatMessages() and
// formatPendingTurns() go through this so the upstream conversation format
// cannot drift between the full-history and incremental paths (they must agree
// on what the model already saw).
function renderTurn(msg) {
    if (!msg || !msg.content) return '';
    if (msg.role === 'user') {
        return `User: ${normalizeMessageContent(msg.content)}\n\n`;
    }
    if (msg.role === 'system') {
        return `System: ${normalizeMessageContent(msg.content)}\n\n`;
    }
    if (msg.role === 'tool') {
        return `<tool_result>\n${toolResultBody(msg.content)}\n</tool_result>\n\n`;
    }
    return '';
}

// Render only the pending turns (user/tool, plus mid-conversation system) into
// the upstream conversation format.
function formatPendingTurns(turns) {
    let conversation = '';
    for (const msg of turns || []) conversation += renderTurn(msg);
    return conversation.trim();
}

// Render an OpenAI `response_format` object as a plain-text instruction for the
// system prompt. DS has no native structured-output mode, so this is a prompt
// downgrade (mirrors the upstream adapter's format_response_text):
//   - json_object: ask for a bare JSON object;
//   - json_schema: emit the schema inside a fenced json block;
//   - text / unknown: nothing (free-form).
// Returns '' when there is no instruction to add.
function formatResponseFormat(responseFormat) {
    if (!responseFormat || typeof responseFormat !== 'object') return '';
    const type = String(responseFormat.type || '');
    if (type === 'json_object') {
        return 'Output a valid JSON object directly, without any markdown code fences or explanatory text.';
    }
    if (type === 'json_schema') {
        const schema = responseFormat.json_schema;
        const schemaText = schema ? JSON.stringify(schema) : '';
        if (!schemaText) return 'Respond in JSON format.';
        return `Respond in JSON format. The output JSON must follow this schema:\n\n~~~json\n${schemaText}\n~~~`;
    }
    if (type === 'text') return '';
    return type ? `Respond in ${type} format.` : '';
}

// Render the configurable response-length cap as a plain-text system-prompt
// instruction. DS has no native max-tokens knob, so the only lever is the
// prompt: ask the model to stay within N words and to summarise + ask before
// spilling over. `0` (or a non-positive/non-finite value) disables it.
// Returns '' when there is no instruction to add.
function formatResponseLengthLimit(maxWords) {
    if (!Number.isFinite(maxWords) || maxWords <= 0) return '';
    return `Keep your reply within ${maxWords} words. If the content is large, first give a summary of the key points and ask whether to continue, instead of outputting everything at once.`;
}

// Prior reasoning is kept in tool-calling conversations (drop_thinking is
// disabled when tools are present), so a historical assistant turn renders its
// reasoning before the visible content / DSML calls block.
function formatReasoningBlock(reasoning) {
    const text = normalizeMessageContent(reasoning).trim();
    return text ? `<think>\n${text}\n</think>` : '';
}

function formatMessages(messages, tools, responseFormat, toolChoice = 'auto') {
    // Only the leading system messages form the session's system prompt; a
    // system message after the conversation has started stays in place as a
    // V4.1 mid-conversation system turn (see computeTurnKeys()).
    let systemPrompt = '';
    let seenNonSystem = false;
    for (const msg of messages) {
        if (!msg) continue;
        if (msg.role !== 'system') {
            seenNonSystem = true;
            continue;
        }
        if (!seenNonSystem && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools, toolChoice);
    const formatText = formatResponseFormat(responseFormat);
    if (formatText) systemPrompt += `\n\n${formatText}`;
    const lengthText = formatResponseLengthLimit(config.get().maxResponseWords);
    if (lengthText) systemPrompt += `\n\n${lengthText}`;

    // `drop_thinking` (default on): without a tools declaration V4.1 strips
    // reasoning from turns BEFORE the latest user request. Tool results do not
    // start a new user turn, so reasoning inside the current turn is kept
    // across tool calls. Declaring tools disables drop_thinking and every turn
    // keeps its reasoning, which multi-step tool use depends on.
    const keepAllReasoning = Array.isArray(tools) && tools.length > 0;
    let lastUserIndex = -1;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i] && messages[i].role === 'user') lastUserIndex = i;
    }

    let conversation = '';
    let sawNonSystem = false;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;
        if (msg.role === 'system') {
            if (sawNonSystem) conversation += renderTurn(msg);
            continue;
        }
        sawNonSystem = true;
        if (msg.role === 'user' || msg.role === 'tool') {
            conversation += renderTurn(msg);
        } else if (msg.role === 'assistant') {
            const reasoning = (keepAllReasoning || i >= lastUserIndex)
                ? formatReasoningBlock(msg.reasoning_content ?? msg.reasoning)
                : '';
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                conversation += reasoning
                    ? `Assistant: ${reasoning}${formatDsmlCallsBlock(msg.tool_calls)}\n\n`
                    : `Assistant:${formatDsmlCallsBlock(msg.tool_calls)}\n\n`;
            } else if (msg.content || reasoning) {
                const content = msg.content ? normalizeMessageContent(msg.content) : '';
                conversation += reasoning
                    ? `Assistant: ${reasoning}${content ? `\n${content}` : ''}\n\n`
                    : `Assistant: ${content}\n\n`;
            }
        }
    }
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

//
// Paths are collected ONLY from structured tool-result fields, never from free
// text. This prevents prompt-injection: a tool (or any user/assistant text)
// that contains e.g. `MEDIA:/etc/passwd` or a bogus `path` string cannot
// smuggle arbitrary paths into the model's response as attachments.
//
// Recognized structured shapes on a *tool* message:
//   - content as a JSON string or object with a `screenshot_path` / `path`
//     string field pointing at an image.
//   - an explicit `media` array of absolute image paths/objects on the message.
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
        // Only tool results are trusted sources for attachment paths.
        if (!msg || msg.role !== 'tool') continue;
        if (typeof msg.content === 'string' && msg.content) {
            let parsed = null;
            try { parsed = JSON.parse(msg.content); } catch (e) { /* not JSON */ }
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
