'use strict';
// OpenAI Responses API (/v1/responses) support.
//
// This module owns the translation layer between the Responses wire format and
// the internal Chat-Completions-shaped representation the rest of the proxy
// already speaks:
//
//   request:  { input, instructions, tools, ... }  ->  { messages, tools, ... }
//   response: internal { content, toolCall, ... }  ->  { output: [...] } + SSE events
//
// Everything here is pure (no server state, no network) so it can be unit
// tested directly and reused by both the streaming and non-streaming handlers.

const crypto = require('crypto');

const { buildUsageFromTokens, splitIntoChunks } = require('./openai');

// --- ids --------------------------------------------------------------------

function randomId(prefix) {
    return `${prefix}_` + crypto.randomBytes(12).toString('hex');
}

function responseId() { return randomId('resp'); }
function messageItemId() { return randomId('msg'); }
function functionCallItemId() { return randomId('fc'); }
function reasoningItemId() { return randomId('rs'); }

// --- request normalization --------------------------------------------------

function nowSeconds() { return Math.floor(Date.now() / 1000); }

// Normalize a Responses `input` value into a flat list of internal messages.
//
// `input` may be:
//   - a string (shorthand for a single user message)
//   - an array of "items": message items, function_call items, or
//     function_call_output items, plus the Chat-Completions-style role/content
//     objects some SDKs still send.
// Returns an array of internal messages compatible with formatMessages().
function normalizeInput(input) {
    if (input === undefined || input === null) return [];
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];

    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        const type = item.type;

        if (type === 'message' || (type === undefined && item.role)) {
            messages.push({
                role: item.role || 'user',
                content: normalizeContentParts(item.content),
            });
            continue;
        }

        if (type === 'function_call') {
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: item.call_id || item.id || randomId('call'),
                    type: 'function',
                    function: {
                        name: item.name || '',
                        arguments: typeof item.arguments === 'string'
                            ? item.arguments
                            : JSON.stringify(item.arguments ?? {}),
                    },
                }],
            });
            continue;
        }

        if (type === 'function_call_output') {
            const output = typeof item.output === 'string'
                ? item.output
                : JSON.stringify(item.output ?? '');
            messages.push({
                role: 'tool',
                tool_call_id: item.call_id || item.id,
                // Tool output may be a stringified content-part array (e.g. a
                // `read` result carrying an image_url part). Expand it so the
                // shared attachment pipeline can upload the image instead of
                // dumping base64 into the prompt.
                content: normalizeContentParts(output),
            });
            continue;
        }

        if (type === 'reasoning') {
            // Reasoning items carry model-internal state we do not forward.
            continue;
        }

        // Fallback: an object with role/content but no explicit type.
        if (item.role) {
            messages.push({ role: item.role, content: normalizeContentParts(item.content) });
        }
    }
    return messages;
}

// Collapse Responses content parts (input_text / output_text / text) into a
// single string. Image parts (`input_image` / `image_url`) are preserved as
// Chat-Completions `image_url` parts so the shared attachment pipeline can
// upload them; when only text is present we keep the old flat-string shape.
// A tool output may be a JSON-encoded array of content parts, e.g.
//   [{"type":"input_text","text":"..."},{"type":"input_image",...}]
// Parse it back into a real array so image parts survive normalization.
function maybeParsePartsArray(str) {
    const trimmed = str.trim();
    if (!trimmed.startsWith('[')) return null;
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch (e) { return null; }
    if (!Array.isArray(parsed)) return null;
    const hasPart = parsed.some(p => p && typeof p === 'object' && typeof p.type === 'string');
    return hasPart ? parsed : null;
}

function normalizeContentParts(content) {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') {
        const parsed = maybeParsePartsArray(content);
        if (!parsed) return content;
        content = parsed;
    }
    if (!Array.isArray(content)) return String(content);

    const texts = [];
    const images = [];
    for (const part of content) {
        if (typeof part === 'string') { texts.push(part); continue; }
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'input_image' || part.type === 'image_url') {
            const url = typeof part.image_url === 'string'
                ? part.image_url
                : part.image_url?.url || part.url;
            if (url) {
                images.push({
                    type: 'image_url',
                    image_url: { url, ...(part.detail !== undefined ? { detail: part.detail } : {}) },
                });
            }
            continue;
        }
        if (typeof part.text === 'string') texts.push(part.text);
    }

    // Text-only: preserve the flat-string contract the prompt builder expects.
    if (images.length === 0) return texts.join('\n');

    const merged = [];
    if (texts.length > 0) merged.push({ type: 'text', text: texts.join('\n') });
    merged.push(...images);
    return merged;
}

// Convert Responses `tools` (flat function shape) into the Chat-Completions
// nested shape the prompt builder expects. Already-nested tools pass through.
function normalizeTools(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.map(tool => {
        if (!tool || typeof tool !== 'object') return null;
        if (tool.type && tool.type !== 'function') return null; // hosted tools unsupported
        if (tool.function && typeof tool.function === 'object') return tool; // already nested
        if (typeof tool.name === 'string') {
            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                },
            };
        }
        return null;
    }).filter(Boolean);
}

// Parse + minimally validate a Responses body. Pure, mirrors parseChatRequest.
function parseResponsesRequest(body) {
    let params;
    try { params = JSON.parse(body || '{}'); }
    catch (e) { return { ok: false, error: { message: 'Request body is not valid JSON.', type: 'invalid_request_error', status: 400 } }; }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return { ok: false, error: { message: 'Request body must be a JSON object.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.input !== undefined && typeof params.input !== 'string' && !Array.isArray(params.input)) {
        return { ok: false, error: { message: 'Field input must be a string or an array.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.tools !== undefined && !Array.isArray(params.tools)) {
        return { ok: false, error: { message: 'Field tools must be an array.', type: 'invalid_request_error', status: 400 } };
    }
    return { ok: true, params };
}

// Build the internal parameter object from a parsed Responses body.
//
// The proxy is stateless with respect to Responses-API server-side history:
// a client-supplied `previous_response_id` is accepted but ignored (not stored
// or resolved), matching the upstream DeepSeek API (stateless) and the clients
// we serve (they always resend the full `input`).
function toInternalParams(params) {
    const messages = normalizeInput(params.input);
    if (typeof params.instructions === 'string' && params.instructions.trim()) {
        messages.unshift({ role: 'system', content: params.instructions });
    }
    return {
        messages,
        tools: normalizeTools(params.tools),
        stream: params.stream === true,
        includeUsage: params.stream === true && params.stream_options?.include_usage === true,
        thinkingEnabled: params.reasoning?.effort !== undefined || params.reasoning_effort !== undefined,
    };
}

// --- response building ------------------------------------------------------

// Build a non-streaming Responses object from the internal recovery result.
// `contextTokens` is the accumulated upstream context size.
function buildResponse({
    content = '',
    reasoningContent = '',
    toolCall = null,
    finishReason = null,
    contextTokens = 0,
    model = 'deepseek-chat',
    responseId: explicitId = null,
} = {}) {
    const output = [];

    if (reasoningContent) {
        output.push({
            type: 'reasoning',
            id: reasoningItemId(),
            summary: [{ type: 'summary_text', text: reasoningContent }],
        });
    }

    if (toolCall) {
        output.push({
            type: 'function_call',
            id: functionCallItemId(),
            call_id: toolCall.id || randomId('call'),
            name: toolCall.name,
            arguments: toolCall.arguments,
            status: 'completed',
        });
    } else {
        output.push({
            type: 'message',
            id: messageItemId(),
            role: 'assistant',
            status: 'completed',
            content: content
                ? [{ type: 'output_text', text: content, annotations: [] }]
                : [],
        });
    }

    const usage = buildUsageFromTokens(contextTokens, content, reasoningContent);
    const completed = finishReason === 'length' ? 'incomplete' : 'completed';

    return {
        id: explicitId || responseId(),
        object: 'response',
        created_at: nowSeconds(),
        status: completed,
        model,
        output,
        output_text: toolCall ? '' : content,
        // Always null: this proxy keeps no server-side Responses history.
        previous_response_id: null,
        usage: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            output_tokens_details: { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens },
        },
        ...(finishReason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    };
}

// --- streaming events -------------------------------------------------------

// Emit a Responses-API SSE stream for a completed internal result.
// The real OpenAI Responses stream is highly granular; we emit the events that
// matter to clients (created/in_progress + content part + function call + done).
function sendResponseStream(res, result, { model = 'deepseek-chat', responseId: explicitId = null } = {}) {
    if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }

    const id = explicitId || responseId();
    const created = nowSeconds();
    const emit = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    };

    const responseBase = {
        id,
        object: 'response',
        created_at: created,
        model,
        status: 'in_progress',
        output: [],
        // Always null: this proxy keeps no server-side Responses history.
        previous_response_id: null,
    };

    emit('response.created', { response: { ...responseBase, status: 'in_progress' } });
    emit('response.in_progress', { response: responseBase });

    const { content = '', reasoningContent = '', toolCall = null, finishReason = null, contextTokens = 0 } = result;
    const outputItems = [];

    if (reasoningContent) {
        const itemId = reasoningItemId();
        const item = {
            type: 'reasoning',
            id: itemId,
            summary: [],
            status: 'in_progress',
        };
        emit('response.output_item.added', { output_index: outputItems.length, item });
        const summaryIndex = 0;
        emit('response.reasoning_summary_part.added', { item_id: itemId, output_index: outputItems.length, summary_index: summaryIndex, part: { type: 'summary_text', text: '' } });
        for (const chunk of splitIntoChunks(reasoningContent)) {
            emit('response.reasoning_summary_text.delta', { item_id: itemId, output_index: outputItems.length, summary_index: summaryIndex, delta: chunk });
        }
        emit('response.reasoning_summary_text.done', { item_id: itemId, output_index: outputItems.length, summary_index: summaryIndex, text: reasoningContent });
        item.summary.push({ type: 'summary_text', text: reasoningContent });
        item.status = 'completed';
        emit('response.output_item.done', { output_index: outputItems.length, item });
        outputItems.push(item);
    }

    if (toolCall) {
        const itemId = functionCallItemId();
        const item = {
            type: 'function_call',
            id: itemId,
            call_id: toolCall.id || randomId('call'),
            name: toolCall.name,
            arguments: '',
            status: 'in_progress',
        };
        emit('response.output_item.added', { output_index: outputItems.length, item });
        for (const chunk of splitIntoChunks(toolCall.arguments)) {
            emit('response.function_call_arguments.delta', { item_id: itemId, output_index: outputItems.length, delta: chunk });
        }
        emit('response.function_call_arguments.done', { item_id: itemId, output_index: outputItems.length, arguments: toolCall.arguments });
        item.arguments = toolCall.arguments;
        item.status = 'completed';
        emit('response.output_item.done', { output_index: outputItems.length, item });
        outputItems.push(item);
    } else {
        const itemId = messageItemId();
        const item = {
            type: 'message',
            id: itemId,
            role: 'assistant',
            status: 'in_progress',
            content: [],
        };
        emit('response.output_item.added', { output_index: outputItems.length, item });
        const contentIndex = 0;
        emit('response.content_part.added', { item_id: itemId, output_index: outputItems.length, content_index: contentIndex, part: { type: 'output_text', text: '', annotations: [] } });
        for (const chunk of splitIntoChunks(content)) {
            emit('response.output_text.delta', { item_id: itemId, output_index: outputItems.length, content_index: contentIndex, delta: chunk });
        }
        emit('response.output_text.done', { item_id: itemId, output_index: outputItems.length, content_index: contentIndex, text: content });
        const part = { type: 'output_text', text: content, annotations: [] };
        emit('response.content_part.done', { item_id: itemId, output_index: outputItems.length, content_index: contentIndex, part });
        item.content.push(part);
        item.status = 'completed';
        emit('response.output_item.done', { output_index: outputItems.length, item });
        outputItems.push(item);
    }

    const usage = buildUsageFromTokens(contextTokens, content, reasoningContent);
    const finalStatus = finishReason === 'length' ? 'incomplete' : 'completed';
    const finalResponse = {
        ...responseBase,
        status: finalStatus,
        output: outputItems,
        output_text: toolCall ? '' : content,
        usage: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            output_tokens_details: { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens },
        },
        ...(finishReason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    };

    const terminal = finalStatus === 'incomplete' ? 'response.incomplete' : 'response.completed';
    emit(terminal, { response: finalResponse });
    res.write('data: [DONE]\n\n');
    res.end();
}

module.exports = {
    randomId,
    responseId,
    normalizeInput,
    normalizeContentParts,
    normalizeTools,
    parseResponsesRequest,
    toInternalParams,
    buildResponse,
    sendResponseStream,
};
