'use strict';
// HTTP request handling. The router in index.js
// owns the http.Server and process lifecycle; this module owns the per-request
// work (CORS, body reading, session/agent resolution, recovery and response
// writing). Dependencies are injected so the handlers can be unit tested
// without loading auth config or opening sockets.

const httpHelpers = require('./http');
const { selectAccountForSession } = require('./accounts');
const {
    resetRemoteSession, prepareSessionForPrompt, getOrCreateAgentSession,
} = require('./sessions');
const upstream = require('./upstream');
const {
    buildToolCallResponseFromTokens, buildTextResponseFromTokens, splitIntoChunks,
} = require('./openai');
const { formatMessages, collectPendingTurns } = require('./prompt');
const { isTimeoutError } = httpHelpers;
const { runWithRecovery } = require('./recovery');
const responses = require('./responses');
const { parseResponsesRequest } = responses;

const config = require('./config');
const ACCEPTED_POST_PATHS = ['/v1/chat/completions', '/v1/responses'];
const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Apply CORS headers. Returns the request origin (or undefined).
// When `DS_ALLOWED_ORIGINS` is set, only those origins receive an
// Access-Control-Allow-Origin header. When it is empty, an arbitrary Origin
// is reflected only on a loopback bind; on a non-loopback HOST no browser
// origin is allowed (anti-CSRF).
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

// Resolve the agent/session id for a request. `x-agent-session` is an explicit
// override; the session-affinity headers are set by pi and change on `/new`,
// so they let a client force a fresh remote session without extra config.
function resolveAgentId(req, params) {
    const requested =
           req.headers['x-agent-session']
        || req.headers['x-session-affinity']
        || req.headers['x-session-id']
        || req.headers['session_id']
        || req.headers['x-client-request-id']
        || params.session
        || params.user;
    if (requested) return String(requested);
    const remoteAddr = req.socket.remoteAddress || 'unknown';
    return LOCALHOST_ADDRS.has(remoteAddr) ? 'dev-agent' : remoteAddr;
}

// DS reasoning is opt-in: enable it only when the client asks for it via the
// OpenAI `reasoning_effort` field. Absent (undefined) means disabled.
function resolveThinkingEnabled(params) {
    return params.reasoning_effort !== undefined;
}

// Read the request body with a hard size cap. Rejects with { tooLarge } when
// the cap is exceeded. Chunks are collected as Buffers and the cap is checked
// against the real byte length; converting each chunk to a string as it
// arrives would corrupt multibyte characters split across chunk boundaries
// and measure UTF-16 code units instead of bytes.
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
            req.destroy();
            resolve({ body: '', tooLarge: false, errored: false, timedOut: true });
        }, timeoutMs) : null;
        if (timer && typeof timer.unref === 'function') timer.unref();
        const done = (result) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };
        // On a size-cap violation we must NOT destroy the socket: the router
        // needs the still-open connection to write its 413. Stop collecting
        // chunks, drop the buffered body, and keep draining the rest of the
        // request so the client is not blocked on a half-read body.
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
        // A socket error is NOT a size violation: report it separately so the
        // router can return 400/408 instead of a misleading 413.
        req.on('error', () => { errored = true; done({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false, errored: true }); });
    });
}

// Parse + minimally validate a chat-completions body. Pure.
function parseChatRequest(body) {
    let params;
    try { params = JSON.parse(body || '{}'); }
    catch (e) { return { ok: false, error: { message: 'Request body is not valid JSON.', type: 'invalid_request_error', status: 400 } }; }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return { ok: false, error: { message: 'Request body must be a JSON object.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.messages !== undefined && !Array.isArray(params.messages)) {
        return { ok: false, error: { message: 'Field messages must be an array.', type: 'invalid_request_error', status: 400 } };
    }
    if (params.tools !== undefined && !Array.isArray(params.tools)) {
        return { ok: false, error: { message: 'Field tools must be an array.', type: 'invalid_request_error', status: 400 } };
    }
    return { ok: true, params };
}

// Send an OpenAI chat completion as an SSE stream.
function sendOpenAIStream(res, openaiResp, { includeUsage = false } = {}) {
    // Headers are normally written early (before the upstream wait) so SSE
    // keep-alive frames can cover the upstream request. Only write them here
    // when the caller has not already committed the response.
    // Idempotent: writes the SSE head + flush only if not already committed.
    httpHelpers.writeSseHeaders(res);
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const id = openaiResp.id;
    const created = openaiResp.created;
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const writeChunk = (delta, finishReason = null) => {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    };

    // Always lead with a role delta so strict OpenAI clients see a well-formed
    // message before any content/reasoning/tool deltas arrive.
    writeChunk({ role: 'assistant', content: '' });

    if (msg.reasoning_content) {
        for (const chunk of splitIntoChunks(msg.reasoning_content)) {
            writeChunk({ reasoning_content: chunk });
        }
    }

    if (hasToolCalls) {
        // Emit tool calls incrementally, OpenAI-style: the first delta carries
        // id/type/name, later deltas stream argument fragments by index.
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
        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, choices: [], usage: openaiResp.usage }) + '\n\n');
    }
    res.write('data: [DONE]\n\n');
    res.end();
}

// Optional SSE keep-alive: while an upstream request is in flight, send a
// comment frame every `streamKeepAliveMs` so intermediary proxies do not drop
// an idle connection. Returns a stop() function. Disabled when interval is 0.
function startStreamKeepAlive(res, intervalMs = config.get().streamKeepAliveMs) {
    if (!intervalMs || intervalMs <= 0 || typeof res.write !== 'function') return () => {};
    const timer = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (_) { /* connection gone */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
}

// Write an error response. If headers were already sent (streaming), emit a
// terminal SSE error frame + [DONE] so the client does not hang.
function writeError(res, e, { clientGone, activeSession, activeAgentId }) {
    // Redact credentials/upstream-body fragments before they reach logs or CI.
    const safeMessage = httpHelpers.redactError(e);
    console.log('[DS-API] Error:', safeMessage, e.upstreamBody ? `| upstream: ${httpHelpers.redactError(e.upstreamBody)}` : '');
    if (clientGone) return;
    if (res.headersSent) {
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: { message: safeMessage, type: e.type || 'server_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
        } catch (_) { /* connection already gone */ }
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

// Shared request pipeline for both /v1/chat/completions and /v1/responses.
//
// Performs body validation, agent/session resolution, attachment upload, the
// upstream recovery loop and error handling, then hands the successful result
// to `onResult(recovery, ctx)` for protocol-specific serialization. `commit`
// is called just before the (long) upstream wait when the caller wants to
// write SSE headers early (streaming); it must be a no-op otherwise.
async function runCompletionPipeline({ req, res, body, opts, parse, commit, onResult }) {
    const {
        askDSStream, readDSResponse,
        maxEmptyRetries, malformedCooldownMs, requestDeadlineMs,
    } = opts;

    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const requestStartedAt = Date.now();
    const deadlineHit = () => Date.now() - requestStartedAt > requestDeadlineMs;
    let activeSession = null;
    let activeAgentId = null;
    let stopKeepAlive = () => {};

    try {
        const parsed = parse(body);
        if (!parsed.ok) {
            res.writeHead(parsed.error.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: parsed.error.message, type: parsed.error.type } }));
            return;
        }
        const params = parsed.params;
        const { messages, tools, stream, includeUsage, thinkingEnabled } = params;
        const agentId = resolveAgentId(req, params);
        const agentTag = `[${agentId}]`;
        activeAgentId = agentId;
        const session = getOrCreateAgentSession(agentId);
        activeSession = session;

        // Upload any image_url attachments to DS and collect their file ids,
        // using the same sticky account the completion will use.
        const uploadAccount = selectAccountForSession(session, { resetRemoteSession });

        // For streaming requests, commit to the SSE response before the
        // (potentially long) upstream wait so keep-alive comment frames can
        // hold the connection open through idle-timeout proxies. Failures
        // before this point still return a real HTTP status; failures after it
        // are surfaced as an SSE `error` event.
        if (stream) {
            commit();
            stopKeepAlive = startStreamKeepAlive(res);
        }

        // Only attach images from turns the remote session has not seen yet.
        // The client resends the whole conversation on every request, so
        // scanning all `messages` would re-attach the same image to every
        // follow-up turn (and spam "Attached ..." in the log). When the remote
        // session is fresh, every turn is pending and the full history is used.
        const pendingAttachmentTurns = session.id
            ? collectPendingTurns(messages, session)
            : messages;
        const resolveAttachments = opts.resolveMessageAttachments || upstream.resolveMessageAttachments;
        const { fileIds, uploads, failures: uploadFailures } = await resolveAttachments(pendingAttachmentTurns, uploadAccount, agentTag, { shouldAbort: () => clientGone || deadlineHit() });
        if (uploads.length > 0) {
            console.log(`${agentTag} Attached ${uploads.length} file(s): ${uploads.map(u => `${u.filename}->${u.id}`).join(', ')}`);
        }
        if (uploadFailures.length > 0) {
            console.log(`${agentTag} ${uploadFailures.length} attachment(s) failed to upload: ${uploadFailures.map(f => f.error).join('; ')}`);
        }

        const { prompt, systemPrompt } = formatMessages(messages, tools);

        const promptRollover = prepareSessionForPrompt(session);
        if (promptRollover) {
            console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}).`);
        }

        const startTime = Date.now();
        const recovery = await runWithRecovery({
            agentId, agentTag, session, messages, tools, prompt, systemPrompt,
            askDSStream, readDSResponse,
            fileIds,
            thinkingEnabled,
            maxEmptyRetries,
            malformedCooldownMs,
            clientGone: () => clientGone,
            deadlineHit,
        });

        if (!recovery.ok) {
            if (recovery.clientGone) return;
            if (stream && res.headersSent) {
                // Headers already committed as SSE; report the failure in-band.
                res.write(`event: error\ndata: ${JSON.stringify({ error: recovery.error.body })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            res.writeHead(recovery.error.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: recovery.error.body }));
            return;
        }

        const elapsed = Date.now() - startTime;
        onResult(recovery, { stream, includeUsage, agentTag, elapsed, res, clientGone });
    } catch (e) {
        writeError(res, e, { clientGone, activeSession, activeAgentId });
    } finally {
        stopKeepAlive();
    }
}

// Normalize a chat-completions params object into the pipeline contract.
function chatParamsFromParsed(params) {
    return {
        ...params,
        messages: params.messages || [],
        tools: params.tools || [],
        stream: params.stream === true,
        includeUsage: params.stream === true && params.stream_options?.include_usage === true,
        thinkingEnabled: resolveThinkingEnabled(params),
    };
}

// Main POST /v1/chat/completions handler.
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
        onResult: (recovery, { stream, includeUsage, agentTag, elapsed, res: r }) => {
            const { fullContent, reasoningContent, finishReason, toolCall, contextTokens } = recovery;
            // Report the accumulated context size (sum of every delta sent to
            // the current remote session), not just this request's prompt.
            const openaiResponse = toolCall
                ? buildToolCallResponseFromTokens(toolCall, contextTokens, reasoningContent)
                : buildTextResponseFromTokens(fullContent, contextTokens, reasoningContent, finishReason);
            if (stream) {
                sendOpenAIStream(r, openaiResponse, { includeUsage });
                console.log(`${agentTag} Streamed (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                r.writeHead(200, { 'Content-Type': 'application/json' });
                r.end(JSON.stringify(openaiResponse));
                console.log(`${agentTag} Response (tool=${!!toolCall}, ${elapsed}ms, ${fullContent.length} chars)`);
            }
        },
    });
}

// Normalize a Responses params object into the pipeline contract.
function responsesParamsFromParsed(params) {
    const internal = responses.toInternalParams(params);
    return {
        ...params,
        messages: internal.messages,
        tools: internal.tools,
        stream: internal.stream,
        includeUsage: internal.includeUsage,
        thinkingEnabled: internal.thinkingEnabled,
    };
}

// Main POST /v1/responses handler.
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
        onResult: (recovery, { stream, agentTag, elapsed, res: r }) => {
            const { fullContent, reasoningContent, finishReason, toolCall, contextTokens } = recovery;
            const result = { content: fullContent, reasoningContent, toolCall, finishReason, contextTokens };
            if (stream) {
                responses.sendResponseStream(r, result);
                console.log(`${agentTag} Responses streamed (tool=${!!toolCall}) in ${elapsed}ms`);
            } else {
                const response = responses.buildResponse(result);
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
    resolveThinkingEnabled,
    readRequestBody,
    parseChatRequest,
    parseResponsesRequest,
    sendOpenAIStream,
    startStreamKeepAlive,
    writeError,
    handleChatCompletions,
    handleResponses,
};
