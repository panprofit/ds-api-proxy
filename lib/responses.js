'use strict';

const crypto = require('crypto');

const { buildUsageFromTokens, splitIntoChunks } = require('./openai');
const { debugLogLazy } = require('./debug');
const httpHelpers = require('./http');
const reasoning = require('./reasoning');
const { normalizeResponsesRequestSchemas } = require('./json-schema');

function randomId(prefix) {
    return `${prefix}_` + crypto.randomBytes(12).toString('hex');
}

function responseId() { return randomId('resp'); }
function messageItemId() { return randomId('msg'); }
function functionCallItemId() { return randomId('fc'); }
function reasoningItemId() { return randomId('rs'); }

function nowSeconds() { return Math.floor(Date.now() / 1000); }

function extractReasoningText(item) {
    if (typeof item.text === 'string' && item.text) return item.text;
    const texts = [];
    for (const part of Array.isArray(item.summary) ? item.summary : []) {
        if (part && typeof part.text === 'string' && part.text) texts.push(part.text);
    }
    for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part && typeof part.text === 'string' && part.text) texts.push(part.text);
    }
    return texts.join('\n');
}

function normalizeInput(input) {
    if (input === undefined || input === null) return [];
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];

    const messages = [];
    let pendingReasoning = '';
    const flushReasoning = () => {
        if (!pendingReasoning) return;
        messages.push({ role: 'assistant', content: null, reasoning_content: pendingReasoning });
        pendingReasoning = '';
    };
    const takeReasoning = () => {
        const text = pendingReasoning;
        pendingReasoning = '';
        return text;
    };
    const attachReasoning = (message) => {
        const text = takeReasoning();
        if (text) message.reasoning_content = text;
        return message;
    };

    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        const type = item.type;

        if (type === 'reasoning') {
            const text = extractReasoningText(item);
            if (text) {
                pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${text}` : text;
            } else {
                debugLogLazy(console.log, () => `[responses] dropping reasoning item from input${item.id ? ` (${item.id})` : ''}: no forwardable text`);
            }
            continue;
        }

        if (type === 'message' || (type === undefined && item.role)) {
            const role = item.role || 'user';
            if (role !== 'assistant') flushReasoning();
            const message = {
                role,
                content: normalizeContentParts(item.content),
            };
            if (role === 'assistant') attachReasoning(message);
            messages.push(message);
            continue;
        }

        if (type === 'function_call') {
            const message = {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: item.call_id || item.id || randomId('call'),
                    type: 'function',
                    ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
                    function: {
                        name: item.name || '',
                        arguments: typeof item.arguments === 'string'
                            ? item.arguments
                            : JSON.stringify(item.arguments ?? {}),
                    },
                }],
            };
            attachReasoning(message);
            messages.push(message);
            continue;
        }

        if (type === 'function_call_output') {
            flushReasoning();
            const output = typeof item.output === 'string'
                ? item.output
                : JSON.stringify(item.output ?? '');
            messages.push({
                role: 'tool',
                tool_call_id: item.call_id || item.id,

                content: normalizeContentParts(output),
            });
            continue;
        }

        if (item.role) {
            if (item.role !== 'assistant') flushReasoning();
            const message = { role: item.role, content: normalizeContentParts(item.content) };
            if (item.role === 'assistant') attachReasoning(message);
            messages.push(message);
            continue;
        }

        if (type !== undefined) {
            debugLogLazy(console.log, () => `[responses] dropping unrecognized input item type '${type}': no Chat-Completions mapping`);
        }
    }
    flushReasoning();
    return messages;
}

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

    if (images.length === 0) return texts.join('\n');

    const merged = [];
    if (texts.length > 0) merged.push({ type: 'text', text: texts.join('\n') });
    merged.push(...images);
    return merged;
}

function normalizeTools(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.map(tool => {
        if (!tool || typeof tool !== 'object') return null;
        if (tool.type && tool.type !== 'function') {

            debugLogLazy(console.log, () => `[responses] dropping unsupported tool type '${tool.type}': no Chat-Completions equivalent`);
            return null;
        }
        if (typeof tool.function?.name === 'string' && tool.function.name) return tool;
        if (typeof tool.name === 'string') {
            return {
                type: 'function',

                ...(tool.namespace !== undefined ? { namespace: tool.namespace } : {}),
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

function parseResponsesRequest(body) {
    let params;
    try { params = JSON.parse(body || '{}'); }
    catch (e) { return httpHelpers.invalidRequest(httpHelpers.BODY_NOT_JSON); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return httpHelpers.invalidRequest(httpHelpers.BODY_NOT_OBJECT);
    }
    if (params.input !== undefined && typeof params.input !== 'string' && !Array.isArray(params.input)) {
        return { ok: false, error: { message: 'Field input must be a string or an array.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.tools !== undefined && !Array.isArray(params.tools)) {
        return httpHelpers.invalidRequest(httpHelpers.TOOLS_NOT_ARRAY);
    }
    const thinkingError = reasoning.validateThinkingParams(params, { responses: true });
    if (thinkingError) return httpHelpers.invalidRequest(thinkingError);
    const schemaError = normalizeResponsesRequestSchemas(params);
    if (schemaError) return httpHelpers.invalidRequest(schemaError);
    return { ok: true, params };
}

function toResponseFormat(params) {
    const format = params.text && typeof params.text === 'object' ? params.text.format : null;
    if (!format || typeof format !== 'object') return undefined;
    const type = String(format.type || '');
    if (type === 'json_object') return { type: 'json_object' };
    if (type === 'json_schema') {
        return {
            type: 'json_schema',
            json_schema: {
                name: format.name,
                schema: format.schema,
                strict: format.strict,
            },
        };
    }
    return undefined;
}

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
        thinkingEnabled: reasoning.resolveResponsesThinkingEnabled(params),
        response_format: toResponseFormat(params),

        searchEnabled: params.web_search_options !== undefined && params.web_search_options !== null
            ? true
            : undefined,
    };
}

function normalizeToolCalls(toolCall, toolCalls) {
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return toolCalls;
    return toolCall ? [toolCall] : [];
}

function buildResponse({
    content = '',
    reasoningContent = '',
    toolCall = null,
    toolCalls = null,
    finishReason = null,
    contextTokens = 0,
    model = 'default',
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

    const calls = normalizeToolCalls(toolCall, toolCalls);
    if (content) {
        output.push({
            type: 'message',
            id: messageItemId(),
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: content, annotations: [] }],
        });
    }
    if (calls.length > 0) {
        for (const call of calls) {
            output.push({
                type: 'function_call',
                id: functionCallItemId(),
                call_id: call.id || randomId('call'),
                name: call.name,
                arguments: call.arguments,
                status: 'completed',
            });
        }
    } else if (!content) {
        output.push({
            type: 'message',
            id: messageItemId(),
            role: 'assistant',
            status: 'completed',
            content: [],
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
        output_text: content,

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

/**
 * @param {any} res
 * @param {{ message?: string, type?: string, code?: string, responseId?: string|null }} [opts]
 */
function sendResponseFailed(res, { message, type, code, responseId: explicitId = null } = {}) {
    if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }

    const errorCode = code || type || 'server_error';
    const errorMessage = message || 'Upstream request failed';
    const payload = {
        type: 'response.failed',
        response: {
            id: explicitId || responseId(),
            object: 'response',
            created_at: nowSeconds(),
            status: 'failed',
            output: [],
            previous_response_id: null,
            error: { code: errorCode, message: errorMessage },
        },
    };
    res.write(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
}

function createLiveReasoningStream(res, { model = 'default', responseId: explicitId = null } = {}) {
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

        previous_response_id: null,
    };
    const stream = {
        id,
        created,
        emit,
        responseBase,
        createdEmitted: false,
        itemId: null,
        text: '',
        get reasoningStarted() { return Boolean(stream.itemId); },
        ensureCreated() {
            if (stream.createdEmitted) return;
            stream.createdEmitted = true;
            emit('response.created', { response: { ...responseBase, status: 'in_progress' } });
            emit('response.in_progress', { response: responseBase });
        },
        write(delta) {
            if (!delta) return;
            stream.ensureCreated();
            if (!stream.itemId) {
                stream.itemId = reasoningItemId();
                const item = { type: 'reasoning', id: stream.itemId, summary: [], status: 'in_progress' };
                emit('response.output_item.added', { output_index: 0, item });
                emit('response.reasoning_summary_part.added', {
                    item_id: stream.itemId, output_index: 0, summary_index: 0,
                    part: { type: 'summary_text', text: '' },
                });
            }
            stream.text += delta;
            emit('response.reasoning_summary_text.delta', {
                item_id: stream.itemId, output_index: 0, summary_index: 0, delta,
            });
        },
        finalize(reasoningContent) {
            stream.ensureCreated();
            if (!stream.itemId) return null;
            const candidate = typeof reasoningContent === 'string' ? reasoningContent : '';
            if (candidate && candidate.startsWith(stream.text)) {
                const suffix = candidate.slice(stream.text.length);
                if (suffix) {
                    stream.text += suffix;
                    emit('response.reasoning_summary_text.delta', {
                        item_id: stream.itemId, output_index: 0, summary_index: 0, delta: suffix,
                    });
                }
            }
            emit('response.reasoning_summary_text.done', {
                item_id: stream.itemId, output_index: 0, summary_index: 0, text: stream.text,
            });
            const item = {
                type: 'reasoning',
                id: stream.itemId,
                summary: [{ type: 'summary_text', text: stream.text }],
                status: 'completed',
            };
            emit('response.output_item.done', { output_index: 0, item });
            return item;
        },
    };
    return stream;
}

function sendResponseStream(res, result, { model = 'default', responseId: explicitId = null, liveReasoning = null } = {}) {
    if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }

    const live = liveReasoning;
    const id = live ? live.id : (explicitId || responseId());
    const created = live ? live.created : nowSeconds();
    const emit = live ? live.emit : (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    };

    const responseBase = live ? live.responseBase : {
        id,
        object: 'response',
        created_at: created,
        model,
        status: 'in_progress',
        output: [],

        previous_response_id: null,
    };

    if (live) {
        live.ensureCreated();
    } else {
        emit('response.created', { response: { ...responseBase, status: 'in_progress' } });
        emit('response.in_progress', { response: responseBase });
    }

    const { content = '', reasoningContent = '', toolCall = null, toolCalls = null, finishReason = null, contextTokens = 0 } = result;
    const calls = normalizeToolCalls(toolCall, toolCalls);
    const outputItems = [];

    if (live && live.reasoningStarted) {
        const item = live.finalize(reasoningContent);
        if (item) outputItems.push(item);
    } else if (reasoningContent) {
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

    if (content) {
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

    if (calls.length > 0) {
        for (const call of calls) {
            const itemId = functionCallItemId();
            const item = {
                type: 'function_call',
                id: itemId,
                call_id: call.id || randomId('call'),
                name: call.name,
                arguments: '',
                status: 'in_progress',
            };
            emit('response.output_item.added', { output_index: outputItems.length, item });
            for (const chunk of splitIntoChunks(call.arguments)) {
                emit('response.function_call_arguments.delta', { item_id: itemId, output_index: outputItems.length, delta: chunk });
            }
            emit('response.function_call_arguments.done', { item_id: itemId, output_index: outputItems.length, arguments: call.arguments });
            item.arguments = call.arguments;
            item.status = 'completed';
            emit('response.output_item.done', { output_index: outputItems.length, item });
            outputItems.push(item);
        }
    } else if (!content) {
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
        emit('response.output_text.done', { item_id: itemId, output_index: outputItems.length, content_index: contentIndex, text: content });
        const part = { type: 'output_text', text: content, annotations: [] };
        emit('response.content_part.done', { item_id: itemId, output_index: outputItems.length, content_index: contentIndex, part });
        item.content.push(part);
        item.status = 'completed';
        emit('response.output_item.done', { output_index: outputItems.length, item });
        outputItems.push(item);
    }

    const effectiveReasoning = live && live.reasoningStarted ? live.text : reasoningContent;
    const usage = buildUsageFromTokens(contextTokens, content, effectiveReasoning);
    const finalStatus = finishReason === 'length' ? 'incomplete' : 'completed';
    const finalResponse = {
        ...responseBase,
        status: finalStatus,
        output: outputItems,
        output_text: content,
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
    responseId,
    normalizeInput,
    normalizeContentParts,
    normalizeTools,
    parseResponsesRequest,
    toInternalParams,
    buildResponse,
    createLiveReasoningStream,
    sendResponseStream,
    sendResponseFailed,
};
