'use strict';
const { isDebugEnabled } = require('./debug');
const { truncateForLog } = require('./http');
// SSE stream reader. Kept in its own module so it can be unit-tested without
// starting the HTTP server or loading auth config; index.js uses it as the
// single source of truth.

function isAssistantOutputFragment(fragment) {
    return fragment
        && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH')
        && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDSModelErrorEvent(event) {
    return event && event.type === 'error';
}

// DS signals an account-level mute out-of-band as a plain JSON body instead of
// an SSE stream: {"code":0,...,"data":{"biz_code":5,"biz_msg":"user is muted",
// "biz_data":{"is_muted":1,"mute_until":<unix seconds>}}}. It arrives with HTTP
// 200 and no `data:` lines, so readDSResponse() would otherwise see it as an
// empty response and rotate accounts pointlessly. Detecting it here lets the
// recovery loop park the account until `mute_until` instead.
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

function debugSseEnabled(env = process.env) {
    return isDebugEnabled(env);
}

// Diagnostic switch for the raw SSE dump. Read lazily per call so tests can
// toggle it via an injected env object. DS_DUMP_SSE=1 enables it.
function dumpSseEnabled(env = process.env) {
    const raw = String(env.DS_DUMP_SSE || '').toLowerCase();
    return raw === '1' || raw === 'true';
}

async function readDSResponse(readable, session, agentTag, options = {}) {
    const log = options.log || console.log;
    const debugSse = options.debugSse !== undefined ? !!options.debugSse : debugSseEnabled();
    // Diagnostic-only: when set, log every raw `data:` line and a final path
    // histogram, to learn how DS currently frames its stream (which `p`
    // carries content, whether message_id/FINISHED arrive). Independent of
    // `debugSse` so it never fires implicitly; opt in with DS_DUMP_SSE=1 or
    // the `dumpRawStream` option.
    const dumpRawStream = options.dumpRawStream !== undefined ? !!options.dumpRawStream : dumpSseEnabled();

    let buffer = '';
    let lastPath = null;
    const fragments = [];
    const pathCounts = dumpRawStream ? new Map() : null;
    // Running text totals for the fragments collected so far. Kept as
    // accumulators so each append is O(1); re-concatenating every fragment on
    // every event would be O(n^2) on long streams.
    let fragmentResponseText = '';
    let fragmentThinkText = '';
    let parsedEvents = 0;
    let parseErrors = 0;
    let fullContent = '';
    let reasoningContent = '';
    let newMessageId = null;
    let finishReason = null;
    let modelError = null;
    // Raw text preview captured only for diagnostics. Empty-bodied 200s and
    // WAF/captcha HTML pages produce zero `data:` events, so events=0 alone
    // cannot tell an empty stream from a non-SSE body; keeping the first bytes
    // lets the dump show which one it was.
    let rawPreview = '';
    const RAW_PREVIEW_LIMIT = 300;
    // Full raw body (capped) used to detect a DS `user is muted` JSON payload,
    // which arrives as a non-SSE body. Kept separate from `rawPreview` so the
    // cap and the trailing-`buffer` logic cannot duplicate bytes.
    let rawBody = '';
    const RAW_BODY_LIMIT = 4096;
    // Set when the body is a DS `user is muted` JSON payload rather than SSE.
    let muted = null;

    // Publish the accumulated fragment totals onto the result fields. Mirrors
    // the previous rebuild-from-scratch logic: fullContent is only overwritten
    // when there is response text, reasoningContent always reflects the total.
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
                    // Events without a `p` (keep-alives, terminal frames) are not
                    // paths; leave lastPath untouched so the previous path's
                    // handler is not re-run for them.
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
                    // Last-resort scan: some DS error/edge events carry the id in
                    // an unexpected place; capture it before the stream ends.
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
    }

    if (modelError) {
        // A model error event (e.g. finish_reason=generation_err, "Server
        // temporarily unavailable.") is NOT a usable assistant turn, so the
        // remote session must not be advanced to it. The recovery loop retries
        // the last request in the SAME session and has to branch from the
        // previous, valid message; advancing here would fork off the failed
        // node. Keep the parent (and messageCount) where they were.
        log(`${agentTag} model error (${modelError.finish_reason || modelError.content || 'error'}); not advancing parent=${session.parentMessageId || 'null'}`);
    } else if (newMessageId) {
        session.parentMessageId = newMessageId;
        session.messageCount++;
        // A usable assistant turn is conversation activity: refresh the idle
        // TTL anchor so an actively-used session is never rolled over. Only
        // real turns count (not a bare getOrCreateAgentSession lookup).
        session.lastActivityAt = Date.now();
    } else {
        // Do not advance the remote session: a missing id means the next
        // call cannot set parent_message_id, so reuse the previous one and
        // let the empty/malformed-response recovery handle it.
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
            // No parsed events: show what actually arrived so an empty body can
            // be told apart from a non-SSE (HTML/WAF) body.
            const bodyPreview = rawBody.trim();
            log(`${agentTag} [SSE dump] no events received; raw body preview (${bodyPreview.length} chars): ${truncateForLog(bodyPreview, RAW_PREVIEW_LIMIT, '')}`);
        }
    }
    // A muted body produces zero events; detect it from the captured bytes so
    // the caller can park the account instead of treating it as empty.
    if (parsedEvents === 0) {
        muted = parseMutedBody(rawBody);
        if (muted) {
            log(`${agentTag} DS account muted (${muted.message}${muted.muteUntil ? ` until ${new Date(muted.muteUntil * 1000).toISOString()}` : ''}); parking account.`);
        }
    }
    return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError, muted };
}

module.exports = {
    debugSseEnabled,
    dumpSseEnabled,
    readDSResponse,
    isAssistantOutputFragment,
    isReasoningFragment,
    isDSModelErrorEvent,
    parseMutedBody,
    applyResponsePatchOperations,
    findMessageId,
};
