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
    isContextTooLongError,
    normalizeRetryResponse,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    isAuthExpiredError,
};
