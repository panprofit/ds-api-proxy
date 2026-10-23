'use strict';

const httpHelpers = require('./http');
const { selectAccountForSession } = require('./accounts');
const {
    resetRemoteSession, prepareSessionForPrompt, getOrCreateAgentSession, deleteSession,
} = require('./sessions');
const upstream = require('./upstream');
const {
    buildToolCallResponseFromTokens, buildTextResponseFromTokens, splitIntoChunks, DEFAULT_MODEL,
    randomObfuscationPadding, obfuscationPadLength,
} = require('./openai');
const { formatMessages, collectPendingTurns } = require('./prompt');
const { isTimeoutError } = httpHelpers;
const { runWithRecovery } = require('./recovery');
const metrics = require('./metrics');
const responses = require('./responses');
const { parseResponsesRequest } = responses;
const reasoning = require('./reasoning');
const { normalizeChatRequestSchemas } = require('./json-schema');

const crypto = require('crypto');
const config = require('./config');
const ACCEPTED_POST_PATHS = ['/v1/chat/completions', '/v1/responses'];

function applyCors(req, res) {
    const requestOrigin = req.headers.origin;
    const cfg = config.get();
    httpHelpers.applyCorsHeaders(res, {
        requestOrigin,
        allowedOrigins: cfg.allowedOrigins,
        allowAnyOrigin: cfg.corsAllowAnyOrigin,
    });
    return requestOrigin;
}

function resolveAgentId(req, params) {

    const requested = config.get().ignoreAgentSession ? null : (
           req.headers['x-agent-session']
        || req.headers['x-session-affinity']
        || req.headers['x-session-id']
        || req.headers['session_id']
        || req.headers['x-client-request-id']
        || params.session
        || params.user
    );
    if (requested) return { agentId: String(requested), ephemeral: false };
    return { agentId: crypto.randomUUID(), ephemeral: true };
}

function resolveSearchEnabled(params, cfg = config.get()) {
    if (params.web_search_options !== undefined && params.web_search_options !== null) return true;
    return cfg.defaultSearchEnabled !== false;
}

function resolveTools(params) {
    if (Array.isArray(params?.tools)) return params.tools;
    if (Array.isArray(params?.functions)) {
        return params.functions
            .filter(fn => fn && typeof fn === 'object' && fn.name)
            .map(fn => ({ type: 'function', function: fn }));
    }
    return [];
}

function resolveToolChoice(params) {
    const choice = params?.tool_choice;
    if (choice === 'none' || choice === 'required' || choice === 'auto') return choice;
    if (choice && typeof choice === 'object') {
        const name = choice.function?.name || choice.name;
        if (name) return { name: String(name) };
    }
    const legacy = params?.function_call;
    if (legacy === 'none' || legacy === 'auto') return legacy;
    if (legacy && typeof legacy === 'object' && legacy.name) return { name: String(legacy.name) };
    return 'auto';
}

function normalizeStop(stop) {
    const list = Array.isArray(stop) ? stop : (typeof stop === 'string' ? [stop] : []);
    const out = [];
    for (const s of list) {
        if (typeof s === 'string' && s && !out.includes(s)) out.push(s);
    }
    return out;
}

function readRequestBody(req, maxBytes = config.get().maxBodyBytes, { timeoutMs = config.get().bodyReadTimeoutMs } = {}) {
    return new Promise((resolve) => {
        const chunks = [];
        let received = 0;
        let tooLarge = false;
        let errored = false;
        let settled = false;
        const timer = timeoutMs > 0 ? setTimeout(() => {
            if (settled) return;
            settled = true;

            req.removeListener('data', onData);
            if (typeof req.resume === 'function') req.resume();
            resolve({ body: '', tooLarge: false, errored: false, timedOut: true });
        }, timeoutMs) : null;
        if (timer && typeof timer.unref === 'function') timer.unref();
        const done = (result) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };

        const onData = chunk => {
            if (tooLarge || settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buf.length;
            if (received > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                req.removeListener('data', onData);
                if (typeof req.resume === 'function') req.resume();
                done({ body: '', tooLarge: true, errored: false });
                return;
            }
            chunks.push(buf);
        };
        req.on('data', onData);
        req.on('end', () => done({ body: Buffer.concat(chunks).toString('utf8'), tooLarge, errored }));

        req.on('error', () => { errored = true; done({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false, errored: true }); });
    });
}

function parseChatRequest(body) {
    let params;
    try { params = JSON.parse(body || '{}'); }
    catch (e) { return httpHelpers.invalidRequest(httpHelpers.BODY_NOT_JSON); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return httpHelpers.invalidRequest(httpHelpers.BODY_NOT_OBJECT);
    }
    if (params.messages !== undefined && !Array.isArray(params.messages)) {
        return { ok: false, error: { message: 'Field messages must be an array.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.tools !== undefined && !Array.isArray(params.tools)) {
        return httpHelpers.invalidRequest(httpHelpers.TOOLS_NOT_ARRAY);
    }
    if (params.functions !== undefined && !Array.isArray(params.functions)) {
        return { ok: false, error: { message: 'Field functions must be an array.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.tool_choice !== undefined && typeof params.tool_choice !== 'string' && typeof params.tool_choice !== 'object') {
        return { ok: false, error: { message: 'Field tool_choice must be a string or object.', type: 'invalid_request_error', status: 400 } };
    }
    const messageError = validateMessages(params.messages);
    if (messageError) {
        return { ok: false, error: { message: messageError, type: 'invalid_request_error', status: 400 } };
    }
    const thinkingError = reasoning.validateThinkingParams(params);
    if (thinkingError) {
        return { ok: false, error: { message: thinkingError, type: 'invalid_request_error', status: 400 } };
    }
    const schemaError = normalizeChatRequestSchemas(params);
    if (schemaError) {
        return { ok: false, error: { message: schemaError, type: 'invalid_request_error', status: 400 } };
    }
    return { ok: true, params };
}

function validateMessages(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;
        if (msg.role === 'tool' && !msg.tool_call_id) {
            return `messages[${i}] role 'tool' requires a 'tool_call_id'`;
        }
        if (msg.role === 'function' && !msg.name) {
            return `messages[${i}] role 'function' requires a 'name'`;
        }
    }
    return null;
}

function createOpenAIChunkWriter(res, { id, created, model, includeObfuscation = false }) {
    return (delta, finishReason = null) => {
        const payload = { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };

        if (includeObfuscation) {
            const without = JSON.stringify(payload);
            payload.obfuscation = randomObfuscationPadding(obfuscationPadLength(without.length));
        }
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
}

function createChatLiveReasoningStream(res, model, includeObfuscation = false) {
    const stream = {
        id: `ds-${crypto.randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model,
        text: '',
        roleSent: false,
        write(delta) {
            if (!delta) return;
            stream.text += delta;
            if (!stream.roleSent) {
                stream.roleSent = true;
                stream.writeChunk({ role: 'assistant', content: '' });
            }
            stream.writeChunk({ reasoning_content: delta });
        },
        writeChunk: null,
    };
    stream.writeChunk = createOpenAIChunkWriter(res, {
        id: stream.id,
        created: stream.created,
        model,
        includeObfuscation,
    });
    return stream;
}

function sendOpenAIStream(res, openaiResp, { includeUsage = false, includeObfuscation = false, liveReasoning = null } = {}) {

    httpHelpers.writeSseHeaders(res);
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const id = openaiResp.id;
    const created = openaiResp.created;
    const model = openaiResp.model;
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const writeChunk = createOpenAIChunkWriter(res, { id, created, model, includeObfuscation });

    if (!liveReasoning || !liveReasoning.roleSent) {
        writeChunk({ role: 'assistant', content: '' });
    }

    if (msg.reasoning_content) {
        const alreadyStreamed = liveReasoning ? liveReasoning.text : '';
        const remaining = alreadyStreamed
            ? (msg.reasoning_content.startsWith(alreadyStreamed)
                ? msg.reasoning_content.slice(alreadyStreamed.length)
                : '')
            : msg.reasoning_content;
        for (const chunk of splitIntoChunks(remaining)) {
            writeChunk({ reasoning_content: chunk });
        }
    }

    if (hasToolCalls) {

        for (let i = 0; i < msg.tool_calls.length; i++) {
            const tc = msg.tool_calls[i];
            const args = tc.function?.arguments || '';
            writeChunk({
                tool_calls: [{
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function?.name || '', arguments: '' },
                }],
            });
            if (args) {
                for (const fragment of splitIntoChunks(args)) {
                    writeChunk({ tool_calls: [{ index: i, function: { arguments: fragment } }] });
                }
            }
        }
        writeChunk({}, 'tool_calls');
    } else {
        for (const chunk of splitIntoChunks(msg.content)) {
            writeChunk({ content: chunk });
        }
        writeChunk({}, choice.finish_reason === 'length' ? 'length' : 'stop');
    }
    if (includeUsage) {

        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: openaiResp.usage }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

function startStreamKeepAlive(res, intervalMs = config.get().streamKeepAliveMs) {
    if (!intervalMs || intervalMs <= 0 || typeof res.write !== 'function') return () => {};
    const timer = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (_) {  }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
}

function writeError(res, e, { clientGone, activeSession, activeAgentId }) {

    const safeMessage = httpHelpers.redactError(e);
    console.log('[DS-API] Error:', safeMessage, e.upstreamBody ? `| upstream: ${httpHelpers.redactError(e.upstreamBody)}` : '');
    if (clientGone) return;
    if (res.headersSent) {
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: { message: safeMessage, type: e.type || 'server_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
        } catch (_) {  }
        res.end();
        return;
    }
    const timedOut = isTimeoutError(e);
    const status = e.status || (timedOut ? 504 : 500);
    const headers = { 'Content-Type': 'application/json' };
    if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
    res.writeHead(status, headers);
    const failure = timedOut && activeSession ? resetRemoteSession(activeSession) : null;
    res.end(JSON.stringify({ error: {
        message: safeMessage,
        type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
        ...(failure ? {
            agent: activeAgentId,
            failed_session_id: failure.failedSessionId,
            message_count: failure.failedMessageCount,
            account: failure.accountId,
        } : {}),
    } }));
}

async function runCompletionPipeline({ req, res, body, opts, parse, commit, onResult, onStreamError = null, createLiveReasoning = null }) {
    const {
        askDSStream, readDSResponse,
    } = opts;

    let clientGone = false;
    const clientAbort = new AbortController();
    res.on('close', () => { clientGone = true; clientAbort.abort(); });
    let activeSession = null;
    let activeAgentId = null;

    let ephemeral = false;
    let stopKeepAlive = () => {};

    try {
        const parsed = parse(body);
        if (!parsed.ok) {
            res.writeHead(parsed.error.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: parsed.error.message, type: parsed.error.type } }));
            return;
        }
        const params = parsed.params;
        const {
            messages, tools, toolChoice, stream, includeUsage, includeObfuscation,
            thinkingEnabled, searchEnabled, stop,
        } = params;
        let agentId;
        ({ agentId, ephemeral } = resolveAgentId(req, params));

        const agentTag = `[${httpHelpers.shortAgentId(agentId)}]`;
        activeAgentId = agentId;
        const liveReasoning = stream && createLiveReasoning
            ? createLiveReasoning({ res, params, agentTag })
            : null;
        const session = getOrCreateAgentSession(agentId);
        session.ephemeral = ephemeral;
        activeSession = session;

        const uploadAccount = selectAccountForSession(session, { resetRemoteSession, forceLru: ephemeral });

        const toolCallFormat = 'json';

        if (stream) {
            commit();
            stopKeepAlive = startStreamKeepAlive(res);
        }

        const pendingAttachmentTurns = session.id
            ? collectPendingTurns(messages, session)
            : messages;
        const resolveAttachments = opts.resolveMessageAttachments || upstream.resolveMessageAttachments;
        const { fileIds, uploads, failures: uploadFailures } = await resolveAttachments(pendingAttachmentTurns, uploadAccount, agentTag, { shouldAbort: () => clientGone });
        if (uploads.length > 0) {
            console.log(`${agentTag} Attached ${uploads.length} file(s): ${uploads.map(u => `${u.filename}->${u.id}`).join(', ')}`);
        }
        if (uploadFailures.length > 0) {
            console.log(`${agentTag} ${uploadFailures.length} attachment(s) failed to upload: ${uploadFailures.map(f => f.error).join('; ')}`);
        }

        const fileIdsByAccount = new Map();
        /** @type {(account: any, options?: { shouldAbort?: (() => boolean) | null }) => Promise<string[]>} */
        const resolveFileIds = async (account, { shouldAbort = null } = {}) => {
            const cached = fileIdsByAccount.get(account.id);
            if (cached) return cached;
            const resolved = await resolveAttachments(messages, account, agentTag, { shouldAbort });
            if (resolved.uploads.length > 0) {
                console.log(`${agentTag} Attached ${resolved.uploads.length} file(s) for acct:${account.id}: ${resolved.uploads.map(u => `${u.filename}->${u.id}`).join(', ')}`);
            }
            if (resolved.failures.length > 0) {
                console.log(`${agentTag} ${resolved.failures.length} attachment(s) failed to upload for acct:${account.id}: ${resolved.failures.map(f => f.error).join('; ')}`);
            }
            fileIdsByAccount.set(account.id, resolved.fileIds);
            return resolved.fileIds;
        };

        const { prompt, systemPrompt } = formatMessages(
            messages, tools, params.response_format, toolChoice, toolCallFormat,
        );

        let historyRollover = null;
        if (session.id && session.lastMessagesLength > 0 && messages.length < session.lastMessagesLength) {
            historyRollover = resetRemoteSession(session);
            console.log(`${agentTag} history shrank (${session.lastMessagesLength} -> ${messages.length} messages); resetting remote session ${historyRollover.failedSessionId}.`);
        }
        session.lastMessagesLength = messages.length;

        const promptRollover = prepareSessionForPrompt(session);
        if (promptRollover) {
            console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}).`);
        }

        const startTime = Date.now();
        const recovery = await runWithRecovery({
            agentId, agentTag, session, messages, tools, prompt, systemPrompt,
            toolChoice,
            askDSStream, readDSResponse,
            fileIds,
            fileIdsAccountId: uploadAccount?.id ?? null,
            resolveFileIds,
            thinkingEnabled,
            searchEnabled,
            stop,
            clientGone: () => clientGone,
            abortSignal: clientAbort.signal,
            onReasoningDelta: liveReasoning ? (delta) => liveReasoning.write(delta) : null,
        });

        if (!recovery.ok) {
            if (recovery.clientGone) return;
            if (stream && res.headersSent) {

                if (onStreamError) {
                    onStreamError(recovery.error, { res, agentTag });
                } else {
                    res.write(`event: error\ndata: ${JSON.stringify({ error: recovery.error.body })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                return;
            }
            res.writeHead(recovery.error.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: recovery.error.body }));
            return;
        }

        const elapsed = Date.now() - startTime;
        metrics.inc('completions');
        if (recovery.toolCall) metrics.inc('toolCalls');
        onResult(recovery, { stream, includeUsage, includeObfuscation, agentTag, elapsed, res, clientGone, model: params.model, liveReasoning });
    } catch (e) {
        writeError(res, e, { clientGone, activeSession, activeAgentId });
    } finally {
        stopKeepAlive();

        if (ephemeral && activeSession) {
            resetRemoteSession(activeSession);
            deleteSession(activeAgentId);
        }
    }
}

function chatParamsFromParsed(params) {
    return {
        ...params,
        messages: params.messages || [],
        tools: resolveTools(params),
        toolChoice: resolveToolChoice(params),
        stream: params.stream === true,
        includeUsage: params.stream === true && params.stream_options?.include_usage === true,

        includeObfuscation: params.stream === true && params.stream_options?.include_obfuscation === true,
        thinkingEnabled: reasoning.resolveThinkingEnabled(params),
        searchEnabled: resolveSearchEnabled(params),
        stop: normalizeStop(params.stop),
    };
}

async function handleChatCompletions(req, res, body, opts) {
    await runCompletionPipeline({
        req, res, body, opts,
        parse: (b) => {
            const parsed = parseChatRequest(b);
            return parsed.ok ? { ok: true, params: chatParamsFromParsed(parsed.params) } : parsed;
        },
        commit: () => {
            httpHelpers.writeSseHeaders(res);
        },
        createLiveReasoning: ({ res: r, params }) => createChatLiveReasoningStream(
            r, params.model || DEFAULT_MODEL, params.includeObfuscation === true
        ),
        onResult: (recovery, { stream, includeUsage, includeObfuscation, agentTag, elapsed, res: r, model, liveReasoning }) => {
            const { fullContent, reasoningContent, finishReason, toolCall, contextTokens } = recovery;

            const responseModel = model || DEFAULT_MODEL;
            const openaiResponse = toolCall
                ? buildToolCallResponseFromTokens(toolCall, contextTokens, reasoningContent, responseModel)
                : buildTextResponseFromTokens(fullContent, contextTokens, reasoningContent, finishReason, responseModel);
            if (stream) {
                if (liveReasoning) {
                    openaiResponse.id = liveReasoning.id;
                    openaiResponse.created = liveReasoning.created;
                }
                sendOpenAIStream(r, openaiResponse, { includeUsage, includeObfuscation, liveReasoning });
                console.log(`${agentTag} Streamed (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                r.writeHead(200, { 'Content-Type': 'application/json' });
                r.end(JSON.stringify(openaiResponse));
                console.log(`${agentTag} Response (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
            }
        },
    });
}

function responsesParamsFromParsed(params) {
    const internal = responses.toInternalParams(params);
    return {
        ...params,
        messages: internal.messages,
        tools: internal.tools,
        stream: internal.stream,
        includeUsage: internal.includeUsage,
        thinkingEnabled: internal.thinkingEnabled,

        response_format: internal.response_format,

        searchEnabled: internal.searchEnabled !== undefined
            ? internal.searchEnabled
            : resolveSearchEnabled(params),
    };
}

async function handleResponses(req, res, body, opts) {
    await runCompletionPipeline({
        req, res, body, opts,
        parse: (b) => {
            const parsed = parseResponsesRequest(b);
            return parsed.ok ? { ok: true, params: responsesParamsFromParsed(parsed.params) } : parsed;
        },
        commit: () => {
            httpHelpers.writeSseHeaders(res);
        },
        createLiveReasoning: ({ res: r, params }) => responses.createLiveReasoningStream(r, {
            model: params.model || DEFAULT_MODEL,
        }),
        onStreamError: (error, { res: r }) => {
            const body = error?.body || {};
            responses.sendResponseFailed(r, {
                message: body.message,
                type: body.type,
                code: body.type,
            });
        },
        onResult: (recovery, { stream, agentTag, elapsed, res: r, model, liveReasoning }) => {
            const { fullContent, reasoningContent, finishReason, toolCall, contextTokens } = recovery;
            const result = { content: fullContent, reasoningContent, toolCall, finishReason, contextTokens };
            const responseModel = model || DEFAULT_MODEL;
            if (stream) {
                responses.sendResponseStream(r, result, { model: responseModel, liveReasoning });
                console.log(`${agentTag} Responses streamed (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                const response = responses.buildResponse({ ...result, model: responseModel });
                r.writeHead(200, { 'Content-Type': 'application/json' });
                r.end(JSON.stringify(response));
                console.log(`${agentTag} Responses (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
            }
        },
    });
}

module.exports = {
    ACCEPTED_POST_PATHS,
    applyCors,
    resolveAgentId,
    resolveThinkingEnabled: reasoning.resolveThinkingEnabled,
    resolveSearchEnabled,
    resolveTools,
    resolveToolChoice,
    normalizeStop,
    readRequestBody,
    parseChatRequest,
    parseResponsesRequest,
    sendOpenAIStream,
    startStreamKeepAlive,
    writeError,
    handleChatCompletions,
    handleResponses,
};
