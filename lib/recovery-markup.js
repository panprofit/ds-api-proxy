'use strict';
// Tool-markup diagnostics and recovery passes: detect/describe truncated
// tool-call markup, ask the model to complete it, and fall back to one strict
// retry. The orchestration in recovery.js calls runMarkupCompletion() and
// runStrictToolRetry() in sequence. Both mutate the shared per-request `state`
// object in place.

const {
    parseToolCall, hasUnclosedToolMarkup, looksLikeToolCallMarkup,
    scanDsmlStructuralTags, normalizeToolMarkupTags, MAX_TOOL_MARKUP_CHARS,
    takeJsonParseError,
} = require('./parser');
const { debugLog, isDebugEnabled } = require('./debug');
const { appendPromptInstruction } = require('./prompt');
const { sanitizeContent, isContinuationRecoverySafe } = require('./recovery-classify');
const sessions = require('./sessions');
const { currentConfig, retryDelayMs, sleep } = require('./recovery-util');

// --- tool-markup diagnostics ----------------------------------------------
function describeToolMarkup(content) {
    const value = String(content || '');
    let hasDsml = false;
    try {
        hasDsml = /[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(value);
    } catch (e) { hasDsml = false; }

    let parseError = null;
    try {
        const tc = parseToolCall(value, () => {});
        if (!tc) {
            // parseToolCall swallows the real JSON.parse error; take the last
            // recorded one so the log says *why* it failed (e.g. "Expected ','
            // or '}' ... at position 802" = truncated object) instead of a
            // useless "no-call".
            const jsonErr = takeJsonParseError();
            parseError = jsonErr ? `json:${compactMsg(jsonErr)}` : 'no-call';
        }
    } catch (e) { parseError = `parse-threw:${e && e.message ? e.message : e}`; }

    let dsmlTags = 'n/a';
    if (hasDsml) {
        try {
            const tags = scanDsmlStructuralTags(normalizeToolMarkupTags(value));
            dsmlTags = tags === null ? 'unbalanced/oversized' : String(tags.length);
        } catch (e) { dsmlTags = `scan-threw:${e && e.message ? e.message : e}`; }
    }

    const compact = (t, max) => String(t).slice(0, max).replace(/\s+/g, ' ').trim();
    return {
        length: value.length,
        looksLikeMarkup: looksLikeToolCallMarkup(value),
        shape: hasDsml ? 'dsml' : 'json',
        dsmlTags,
        parseError,
        head: compact(value, 80),
        tail: compact(value.slice(-200), 200),
    };
}

// Shorten a JSON.parse error for a single-line log field: keep the position
// info but drop the noisy "(line 1 column N)" suffix and cap the length.
function compactMsg(msg) {
    return String(msg || '').replace(/\s*\(line \d+ column \d+\)/, '').slice(0, 120);
}

// Dedupe the full markup dump: it is called on every completion round and on
// the strict retry, but the content often does not change between calls. Emit
// the dump only when the value differs from the previous one for this agent.
const lastMarkupDump = new Map();
function debugDumpToolMarkup(agentTag, content, log = console.log) {
    if (!isDebugEnabled()) return;
    const value = String(content || '');
    const fingerprint = `${value.length}:${value.slice(-80)}`;
    if (lastMarkupDump.get(agentTag) === fingerprint) return;
    lastMarkupDump.set(agentTag, fingerprint);
    debugLog(log, `${agentTag} [markup-dump] len=${value.length} cap=${MAX_TOOL_MARKUP_CHARS}`);
    debugLog(log, `${agentTag} [markup-dump] ${JSON.stringify(value.substring(0, 2000))}${value.length > 2000 ? `…(+${value.length - 2000} chars)` : ''}`);
}

// Complete truncated tool-call markup by asking for the remaining characters.
// Mutates `state` (fullContent / toolCall / finishReason).
async function runMarkupCompletion(state, deps) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, fileIds, thinkingEnabled, clientGone, deadlineHit, log } = deps;
    const allowedToolNames = state.allowedToolNames;
    const { maxMarkupCompletion: MAX_MARKUP_COMPLETION } = currentConfig();

    let markupCompletionRounds = 0;
    while (allowedToolNames.size > 0 && !state.toolCall && hasUnclosedToolMarkup(state.fullContent)
           && markupCompletionRounds < MAX_MARKUP_COMPLETION && !clientGone() && !deadlineHit()) {
        markupCompletionRounds++;
        const markupDiag = describeToolMarkup(state.fullContent);
        log(`${agentTag} Unclosed tool-call markup (${markupDiag.length} chars, shape=${markupDiag.shape}, dsmlTags=${markupDiag.dsmlTags}, parse=${markupDiag.parseError || 'ok'}). Completing (${markupCompletionRounds}/${MAX_MARKUP_COMPLETION})...`);
        log(`${agentTag} Markup head=${JSON.stringify(markupDiag.head)} tail=${JSON.stringify(markupDiag.tail)}`);
        debugDumpToolMarkup(agentTag, state.fullContent, log);
        await sleep(retryDelayMs());
        const contBeforeId = session.accountId;
        const contPrompt = appendPromptInstruction(
            `${state.freshPrompt}\n\n[Assistant response so far]\n${state.fullContent}`,
            'Your tool call above was cut off mid-JSON. Complete it so the result is ONE valid JSON object: close every open string, array and brace; do not use real line breaks inside string values (escape them as \\n); escape every double quote inside a string value as \\"; do not repeat what you already wrote. Output only the missing characters.'
        );
        const contCall = await askDSStream({ prompt: 'continue', agentId, freshSessionPrompt: contPrompt, fileIds, thinkingEnabled });
        if (!isContinuationRecoverySafe(contBeforeId, contCall)) {
            log(`${agentTag} completion continuation rotated account; skipping`);
            break;
        }
        const contResult = await readDSResponse(contCall.resp.body, session, agentTag);
        const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
        if (contContent && contContent.trim()) {
            if (contContent.trimStart().startsWith('```')) { log(`${agentTag} Continuation restarts markup; ignoring.`); break; }
            state.fullContent += contContent;
            if (contResult.reasoningContent) state.reasoningContent += (state.reasoningContent ? '\n' : '') + sanitizeContent(contResult.reasoningContent);
            state.finishReason = contResult.finishReason;
            log(`${agentTag} Completion round added ${contContent.length} chars (total: ${state.fullContent.length})`);
            state.toolCall = parseToolCall(state.fullContent);
            if (state.toolCall && !allowedToolNames.has(state.toolCall.name)) state.toolCall = null;
            if (!state.toolCall && !hasUnclosedToolMarkup(state.fullContent)) break;
            if (!state.toolCall) {
                const afterDiag = describeToolMarkup(state.fullContent);
                log(`${agentTag} Markup still unparsed after completion round ${markupCompletionRounds} (${afterDiag.length} chars, shape=${afterDiag.shape}, dsmlTags=${afterDiag.dsmlTags}, parse=${afterDiag.parseError || 'ok'}, tail=${JSON.stringify(afterDiag.tail)})`);
                debugDumpToolMarkup(agentTag, state.fullContent, log);
            }
        } else {
            log(`${agentTag} Completion returned nothing useful, stopping`);
            break;
        }
    }
}

// One strict retry with the fresh prompt when tool-call markup is still
// truncated after the completion rounds. Mutates `state` (fullContent /
// toolCall / reasoningContent).
async function runStrictToolRetry(state, deps) {
    const { agentId, agentTag, session, askDSStream, readDSResponse, fileIds, thinkingEnabled, clientGone, deadlineHit, log } = deps;
    const allowedToolNames = state.allowedToolNames;

    if (!(allowedToolNames.size > 0 && !state.toolCall && hasUnclosedToolMarkup(state.fullContent) && !clientGone() && !deadlineHit())) return;

    const strictDiag = describeToolMarkup(state.fullContent);
    log(`${agentTag} Tool-call markup detected but invalid/truncated (${strictDiag.length} chars, shape=${strictDiag.shape}, dsmlTags=${strictDiag.dsmlTags}, parse=${strictDiag.parseError || 'ok'}). Retrying...`);
    log(`${agentTag} Markup head=${JSON.stringify(strictDiag.head)} tail=${JSON.stringify(strictDiag.tail)}`);
    debugDumpToolMarkup(agentTag, state.fullContent, log);
    sessions.resetRemoteSession(session);
    await sleep(retryDelayMs() * 2);
    const strictRetryPrompt = appendPromptInstruction(
        state.freshPrompt,
        'Emit the tool call as ONE valid JSON object matching the tool_call format. Do not use real line breaks inside string values (escape them as \\n); escape every double quote inside a string value as \\" (a raw " inside a value breaks the JSON); close every string, array and brace. If the value is very large, split it into several smaller tool calls instead of one huge one.'
    );
    const { resp: retryResp2 } = await askDSStream({ prompt: strictRetryPrompt, agentId, freshSessionPrompt: strictRetryPrompt, fileIds, thinkingEnabled });
    const retryResult2 = await readDSResponse(retryResp2.body, session, agentTag);
    const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
    if (retryContent2 && retryContent2.trim()) {
        const retryTc = parseToolCall(retryContent2);
        if (retryTc && allowedToolNames.has(retryTc.name)) {
            log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name}`);
            state.fullContent = retryContent2;
            state.reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
            state.toolCall = retryTc;
        } else {
            const retryDiag = describeToolMarkup(retryContent2);
            log(`${agentTag} Retry still has broken tool markup (${retryDiag.length} chars, shape=${retryDiag.shape}, dsmlTags=${retryDiag.dsmlTags}, parse=${retryDiag.parseError || 'ok'}, tail=${JSON.stringify(retryDiag.tail)}). Returning a safe error instead of leaking it as text.`);
            debugDumpToolMarkup(agentTag, retryContent2, log);
            state.reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : state.reasoningContent;
        }
    }
}


module.exports = {
    describeToolMarkup,
    debugDumpToolMarkup,
    runMarkupCompletion,
    runStrictToolRetry,
};
