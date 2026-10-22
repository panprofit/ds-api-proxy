'use strict';
const config = require('./config');
const { isDebugEnabled } = require('./debug');
const { truncateForLog } = require('./http');

function isAssistantOutputFragment(fragment) {
    return fragment
        && fragment.type === 'RESPONSE'
        && typeof fragment.content === 'string';
}

function stripCitations(text) {
    return String(text || '').replace(/\[citation:\d+\]/g, '');
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDSModelErrorEvent(event) {
    return event && event.type === 'error';
}

function parseMutedBody(text) {
    const raw = String(text || '').trim();
    if (!raw || raw[0] !== '{') return null;
    let json;
    try { json = JSON.parse(raw); }
    catch (e) { return null; }
    const data = json && json.data;
    if (!data || Number(data.biz_code) !== 5) return null;
    const bizMsg = String(data.biz_msg || '');
    if (!/muted/i.test(bizMsg)) return null;
    const muteUntil = Number(data.biz_data && data.biz_data.mute_until);
    return { muteUntil: Number.isFinite(muteUntil) ? muteUntil : null, message: bizMsg };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
        }
    }
}

function findMessageId(value, depth = 0) {
    if (depth > 6 || value === null || typeof value !== 'object') return null;
    for (const key of ['response_message_id', 'message_id', 'messageId']) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            const found = findMessageId(child, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function dumpSseEnabled(env = process.env) {
    const raw = String(env.DS_DUMP_SSE || '').toLowerCase();
    return raw === '1' || raw === 'true';
}

async function readDSResponse(readable, session, agentTag, options = {}) {
    const log = options.log || console.log;
    const debugSse = options.debugSse !== undefined ? !!options.debugSse : isDebugEnabled(options.env);

    const dumpRawStream = options.dumpRawStream !== undefined ? !!options.dumpRawStream : dumpSseEnabled(options.env);
    const now = options.now || Date.now;
    const progressIntervalMs = options.progressIntervalMs !== undefined
        ? Number(options.progressIntervalMs)
        : config.get().sseProgressIntervalMs;

    let rawChars = 0;
    const startedAt = now();
    let lastProgressAt = startedAt;

    let buffer = '';
    let lastPath = null;
    const fragments = [];
    const pathCounts = dumpRawStream ? new Map() : null;

    let fragmentResponseText = '';
    let fragmentThinkText = '';
    let parsedEvents = 0;
    let parseErrors = 0;
    let fullContent = '';
    let reasoningContent = '';
    let newMessageId = null;
    let finishReason = null;
    let modelError = null;

    let rawPreview = '';
    const RAW_PREVIEW_LIMIT = 300;

    let rawBody = '';
    const RAW_BODY_LIMIT = 4096;

    let muted = null;

    const rebuildFragmentState = () => {
        if (fragmentResponseText) fullContent = fragmentResponseText;
        reasoningContent = fragmentThinkText;
    };

    const appendFragments = (value) => {
        const incoming = Array.isArray(value) ? value : [value];
        for (const fragment of incoming) {
            if (!fragment || typeof fragment !== 'object') continue;
            fragments.push({ ...fragment });
            if (isAssistantOutputFragment(fragment)) fragmentResponseText += fragment.content;
            else if (isReasoningFragment(fragment)) fragmentThinkText += fragment.content;
        }
        rebuildFragmentState();
    };

    const resetFragments = () => {
        fragments.length = 0;
        fragmentResponseText = '';
        fragmentThinkText = '';
    };

    const decoder = new TextDecoder();
    for await (const chunk of readable) {
        const decoded = decoder.decode(chunk, { stream: true });
        rawChars += decoded.length;
        if (rawPreview.length < RAW_PREVIEW_LIMIT) {
            rawPreview += decoded;
        }
        if (rawBody.length < RAW_BODY_LIMIT) {
            rawBody += decoded;
        }
        buffer += decoded;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                if (dumpRawStream) log(`${agentTag} [SSE raw] ${line.slice(6, 6 + 500)}`);
                try {
                    const d = JSON.parse(line.slice(6));
                    if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                    if (!newMessageId && d.message_id !== undefined) newMessageId = d.message_id;
                    if (isDSModelErrorEvent(d)) {
                        modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                    }
                    if (d.finish_reason) {
                        finishReason = d.finish_reason;
                    }

                    if (d.p !== undefined) {
                        lastPath = d.p;
                        if (pathCounts) pathCounts.set(lastPath, (pathCounts.get(lastPath) || 0) + 1);
                    }
                    if (d.v && typeof d.v === 'object' && d.v.response) {
                        if (d.v.response.message_id !== undefined) {
                            newMessageId = d.v.response.message_id;
                        }
                        if (d.v.response.content !== undefined) {
                            fullContent = d.v.response.content;
                        }
                        if (Array.isArray(d.v.response.fragments)) {
                            resetFragments();
                            appendFragments(d.v.response.fragments);
                        }
                        if (d.v.response.finish_reason !== undefined) {
                            finishReason = d.v.response.finish_reason;
                        }
                    }
                    if (lastPath === 'response/fragments' && d.v !== undefined) {
                        appendFragments(d.v);
                    }
                    if (lastPath === 'response' && d.v !== undefined) {
                        applyResponsePatchOperations(d.v, appendFragments);
                    }
                    if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                        if (fragments.length > 0) {
                            const lastFragment = fragments[fragments.length - 1];
                            lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                            if (isAssistantOutputFragment(lastFragment)) fragmentResponseText += d.v;
                            else if (isReasoningFragment(lastFragment)) fragmentThinkText += d.v;
                            rebuildFragmentState();
                        }
                    }
                    if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                        fullContent += d.v;
                    }
                    if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                        finishReason = d.v;
                    }
                    if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
                        finishReason = d.v;
                    }
                    if (lastPath === 'response/message_id' && d.v !== undefined && !newMessageId) {
                        newMessageId = typeof d.v === 'string' ? d.v : findMessageId(d.v);
                    }

                    if (!newMessageId) {
                        const swept = findMessageId(d);
                        if (swept) newMessageId = swept;
                    }
                    parsedEvents++;
                } catch (e) {
                    parseErrors++;
                    if (debugSse) log(`${agentTag} [SSE] JSON.parse failed: ${truncateForLog(e.message, 120, '')}`);
                }
            }
        }
        if (progressIntervalMs > 0) {
            const at = now();
            if (at - lastProgressAt >= progressIntervalMs) {
                log(`${agentTag} [SSE] progress: rawChars=${rawChars} contentChars=${fullContent.length} reasoningChars=${reasoningContent.length} events=${parsedEvents} elapsed=${at - startedAt}ms`);
                lastProgressAt = at;
            }
        }
    }

    if (modelError) {

        log(`${agentTag} model error (${modelError.finish_reason || modelError.content || 'error'}); not advancing parent=${session.parentMessageId || 'null'}`);
    } else if (newMessageId) {
        session.parentMessageId = newMessageId;
        session.messageCount++;

        session.lastActivityAt = Date.now();
    } else {

        log(`${agentTag} WARNING: could not extract message_id (events=${parsedEvents}, parseErrors=${parseErrors}, contentChars=${fullContent.length}); keeping parent=${session.parentMessageId || 'null'}`);
    }

    if (parseErrors > 0) {
        log(`${agentTag} [SSE] ${parseErrors} unparseable event(s) out of ${parsedEvents + parseErrors}`);
    }
    if (dumpRawStream) {
        const paths = pathCounts && pathCounts.size > 0
            ? [...pathCounts.entries()].map(([p, n]) => `${p}\u00d7${n}`).join(', ')
            : '(none)';
        log(`${agentTag} [SSE dump] events=${parsedEvents} parseErrors=${parseErrors} contentChars=${fullContent.length} reasoningChars=${reasoningContent.length} messageId=${newMessageId ? 'yes' : 'no'} finishReason=${finishReason || 'none'} paths: ${paths}`);
        if (parsedEvents === 0) {

            const bodyPreview = rawBody.trim();
            log(`${agentTag} [SSE dump] no events received; raw body preview (${bodyPreview.length} chars): ${truncateForLog(bodyPreview, RAW_PREVIEW_LIMIT, '')}`);
        }
    }

    if (parsedEvents === 0) {
        muted = parseMutedBody(rawBody);
        if (muted) {
            log(`${agentTag} DS account muted (${muted.message}${muted.muteUntil ? ` until ${new Date(muted.muteUntil * 1000).toISOString()}` : ''}); parking account.`);
        }
    }
    return { content: stripCitations(fullContent), reasoningContent, messageId: newMessageId, finishReason, modelError, muted };
}

module.exports = {
    dumpSseEnabled,
    readDSResponse,
    parseMutedBody,
    findMessageId,
};
