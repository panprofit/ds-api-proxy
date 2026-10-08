'use strict';
// Classification helpers for the recovery state machine: deciding whether an
// error is a context-length error, whether a continuation is safe to merge, and
// what HTTP status a terminal recovery failure maps to.

function sanitizeContent(text) {
    return String(text == null ? '' : text).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

// Markers that indicate a "continuation" is actually a model refusal rather
// than the next part of the response. Appending such content would corrupt the
// answer, so the recovery loop stops instead of merging it.
const REFUSAL_MARKERS = [
    'i am an ai',
    "i'm an ai",
    'as an ai',
    'i cannot continue',
    "i can't continue",
];

function isRefusalContent(content) {
    const text = String(content || '').toLowerCase();
    return REFUSAL_MARKERS.some(marker => text.includes(marker));
}

// Tool-result echo detection.
//
// A tool result is injected into the assistant stream as an envelope:
//
//   [Tool Result id=call_<uuid>]
//   ...content...
//   [/Tool Result]
//
// The model sometimes *imitates* this format in its own prose (especially
// after a continuation prompt that carried a previous result), which would
// then be merged into `fullContent` as if it were a real turn and leak a fake
// `[Tool Result …]` block to the client. Unlike a refusal, this can appear at
// any point in the content, so the check is line-anchored and requires a
// well-formed, balanced envelope rather than matching the words.
//
// `[Tool Result …]` is the CLIENT/harness format: prompt.formatMessages wraps
// each role:'tool' message in it before sending the conversation upstream. The
// model must NEVER emit it back -- not even with an id the proxy itself issued
// -- so ANY well-formed, balanced envelope in the model's output is treated as
// a forbidden echo and dropped before it reaches the client. A marker line
// without a matching closing tag is left alone: it is more likely a real
// partial continuation that merely starts with the words, and stripping it
// would lose content.
const TOOL_RESULT_OPEN_RE = /^\[Tool Result id=([A-Za-z0-9_./-]+)\]\s*$/;
const TOOL_RESULT_CLOSE_RE = /^\[\/Tool Result\]\s*$/;

function isToolResultEcho(content) {
    const text = String(content == null ? '' : content);
    if (!text.includes('[Tool Result id=')) return false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!TOOL_RESULT_OPEN_RE.test(lines[i])) continue;
        // Require a closing tag later in the text so a bare line that merely
        // looks like a marker is not misread.
        for (let j = i + 1; j < lines.length; j++) {
            if (TOOL_RESULT_CLOSE_RE.test(lines[j])) return true;
        }
    }
    return false;
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

function normalizeRetryResponse(result) {
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

// DS reports brief upstream outages in-band as a model error with
// finish_reason=generation_err (e.g. "Server temporarily unavailable."). That is
// DS itself being unavailable, NOT a dead account: the recovery loop must keep
// retrying the SAME account instead of cooling it down and rotating.
const UPSTREAM_TRANSIENT_FINISH_REASONS = new Set(['generation_err']);
function isUpstreamTransientError(error) {
    if (!error || typeof error === 'string') return false;
    if (UPSTREAM_TRANSIENT_FINISH_REASONS.has(error.finish_reason)) return true;
    const message = `${error.content || ''} ${error.message || ''}`;
    return /server\s+(?:is\s+)?temporarily\s+unavailable|сервер\s+временно\s+недоступен|服务器暂时不可用/i.test(message);
}

function classifyRecoveryFailure(modelError, timedOut = false) {
    if (isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (isUpstreamTransientError(modelError)) return { status: 503, type: 'upstream_unavailable' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    return { status: 502, type: modelError?.type || 'empty_response' };
}

// Errors that mean "this account's credentials are no longer usable" --
// expired auth, a captcha challenge, or a DS Web API change -- rather than a
// transient network/upstream failure. Retrying the same account keeps failing
// the same way, so the recovery loop must rotate to a different account.
const AUTH_EXPIRED_PATTERNS = [
    /auth may be expired/i,
    /captcha may be required/i,
    /captcha-blocked/i,
    /ds changed web api/i,
];

// Markers that a short final line is a *promise to act* rather than a
// completed reply. The model narrates the next step ("Let me check the tests",
// "Проверю, что патч не сломал тесты") but the turn ends with finish_reason
// "stop" and no tool call, so the client is left waiting. Matched
// case-insensitively against the tail of the content; multilingual because the
// proxy serves ru/zh/en clients.
const ACTION_PROMISE_MARKERS = [
    /\b(?:let me|i'll|i will|i'm going to|i am going to|now i'll|next,? i)\b/i,
    /\b(?:let's|lets)\s+(?:check|look|see|verify|run|test|inspect|open|read|try)\b/i,
    /\b(?:checking|verifying|running|inspecting|looking)\b[^.!?]*\.\.\.\s*$/i,
    /(?:^|[.!?]\s*)(?:проверю|посмотрю|запущу|проверим|посмотрим|сейчас\s+проверю|давай\s+провер)/i,
    /(?:^|[。！？]\s*)(?:我来|让我|我先|检查一下|看看|运行一下|验证一下|接下来)/,
];

// True when `content` looks like a short promise to perform an action rather
// than a finished answer. Only the trailing portion is inspected: a long answer
// that happens to contain "let me" somewhere in the middle is a real reply, not
// a promise. The caller pairs this with the length/reasoning/finish_reason
// guards in phaseActionPromise.
function looksLikeActionPromise(content) {
    const text = String(content || '').trim();
    if (!text) return false;
    // Inspect the last ~200 chars: the promise is the closing line.
    const tail = text.length > 200 ? text.slice(-200) : text;
    return ACTION_PROMISE_MARKERS.some(re => re.test(tail));
}

function isAuthExpiredError(error) {
    if (!error) return false;
    if (error.type === 'auth_expired' || error.type === 'authentication_error') return true;
    const message = typeof error === 'string'
        ? error
        : `${error.message || ''} ${error.content || ''}`;
    return AUTH_EXPIRED_PATTERNS.some(re => re.test(message));
}

module.exports = {
    sanitizeContent,
    isContinuationRecoverySafe,
    isRefusalContent,
    isToolResultEcho,
    isContextTooLongError,
    normalizeRetryResponse,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    isAuthExpiredError,
    looksLikeActionPromise,
};
