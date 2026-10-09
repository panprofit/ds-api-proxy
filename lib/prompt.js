'use strict';
// Prompt / conversation formatting: tool definitions, message rendering,
// incremental-turn bookkeeping and screenshot-path extraction.
// This domain can evolve independently of the HTTP/SSE/response helpers.

const fs = require('fs');
const { truncateForLog } = require('./http');
const config = require('./config');

// --- Message content normalization -----------------------------------------

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'image_url') return '';
            return part.text || part.content || JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

// --- Tool definitions / prompt building -------------------------------------

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server, REQUEST exactly one tool call. Prefer strict JSON:\n';
    text += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n\n';
    text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += '3. The tool runs on the local server\n';
    text += '4. After the tool executes, the result will be sent to you as a new user/tool message\n';
    text += '5. Never add explanation before or after the tool request when requesting a tool\n';
    text += '6. Keep arguments compact. Do not include large file contents unless the tool schema requires it.\n';
    text += '7. Never fabricate tool results: a diff/log/stdout may only come from a real call made in this same turn\n';
    text += '8. Never claim "done"/"committed"/"tests passed" without a fresh real check shown alongside\n';
    text += '9. Plans are future tense; past tense is reserved strictly for facts produced by a real call\n';
    text += '10. If unsure or a call was not made, say so plainly instead of filling the gap\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
            text += `${truncateForLog(description, 497, '...')}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += '\nREMEMBER: Request tools only with strict JSON format. Never simulate results.';
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

// --- Incremental turns ------------------------------------------------------

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
// pairing each with its occurrence-aware dedup key.
function computeTurnKeys(messages) {
    const seen = new Map();
    const out = [];
    for (const msg of messages || []) {
        if (!msg || msg.role === 'system') continue;
        if (msg.role !== 'user' && msg.role !== 'tool') continue;
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

// Collect every not-yet-forwarded user/tool turn in conversation order.
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
        if (msg && (msg.role === 'user' || msg.role === 'tool')) {
            session.sentKeys.add(cachedTurnKeys.get(msg) || computed.get(msg) || messageFingerprint(msg));
        }
    }
}

// Render only the pending user/tool turns into the upstream conversation format.
function formatPendingTurns(turns) {
    let conversation = '';
    for (const msg of turns || []) {
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${normalizeMessageContent(msg.content)}\n\n`;
        } else if (msg.role === 'tool' && msg.content) {
            const id = msg.tool_call_id ? ` id=${msg.tool_call_id}` : '';
            conversation += `[Tool Result${id}]\n${normalizeMessageContent(msg.content)}\n\n`;
        }
    }
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
        return '请直接输出合法的 JSON 对象，不要包含任何 markdown 代码块标记或其他解释性文字。';
    }
    if (type === 'json_schema') {
        const schema = responseFormat.json_schema;
        const schemaText = schema ? JSON.stringify(schema) : '';
        if (!schemaText) return '以 JSON 的形式输出。';
        return `以 JSON 的形式输出，输出的 JSON 需遵守以下的格式：\n\n~~~json\n${schemaText}\n~~~`;
    }
    if (type === 'text') return '';
    return type ? `请以 ${type} 格式输出。` : '';
}

// Render the configurable response-length cap as a plain-text system-prompt
// instruction. DS has no native max-tokens knob, so the only lever is the
// prompt: ask the model to stay within N words and to summarise + ask before
// spilling over. `0` (or a non-positive/non-finite value) disables it.
// Returns '' when there is no instruction to add.
function formatResponseLengthLimit(maxWords) {
    if (!Number.isFinite(maxWords) || maxWords <= 0) return '';
    return `请将回复控制在 ${maxWords} 字以内。如果内容较多，请先给出要点总结并询问是否需要继续，而不是一次性输出全部内容。`;
}

function formatMessages(messages, tools, responseFormat) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);
    const formatText = formatResponseFormat(responseFormat);
    if (formatText) systemPrompt += `\n\n${formatText}`;
    const lengthText = formatResponseLengthLimit(config.get().maxResponseWords);
    if (lengthText) systemPrompt += `\n\n${lengthText}`;

    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${normalizeMessageContent(msg.content)}\n\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {});
                    const id = tc.id ? ` id=${JSON.stringify(tc.id)}` : '';
                    conversation += `Assistant: {"tool_call":{${id}"name":${JSON.stringify(tc.function.name)},"arguments":${args}}}\n\n`;
                }
            } else if (msg.content) {
                conversation += `Assistant: ${normalizeMessageContent(msg.content)}\n\n`;
            }
        } else if (msg.role === 'tool' && msg.content) {
            const toolContent = normalizeMessageContent(msg.content);
            const id = msg.tool_call_id ? ` id=${msg.tool_call_id}` : '';
            conversation += `[Tool Result${id}]\n${toolContent}\n\n`;
        }
    }
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

// --- Screenshot extraction (fs-based; injectable for tests) ------------------
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
    composePrompt,
    appendPromptInstruction,
    messageFingerprint,
    collectPendingTurns,
    markTurnsSent,
    formatPendingTurns,
    formatMessages,
    formatResponseFormat,
    formatResponseLengthLimit,
    extractScreenshotPaths,
};
