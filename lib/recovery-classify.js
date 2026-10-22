'use strict';

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

const NATIVE_TOOL_RESULT_OPEN_RE = /^<tool_result(?:\s[^<>]*)?>/i;
const NATIVE_TOOL_RESULT_CLOSE_RE = /<\/tool_result>/i;

const NATIVE_TOOL_RESULT_PAIR_RE = /<tool_result(?:\s[^<>]*)?>[\s\S]*?<\/tool_result>/gi;

function stripToolResultEchoes(content) {
    const text = String(content == null ? '' : content);
    if (!/<tool_result/i.test(text)) return text;
    const lines = text.split('\n');
    const out = [];
    let dropping = false;
    for (const originalLine of lines) {

        const line = /<tool_result/i.test(originalLine)
            ? originalLine.replace(NATIVE_TOOL_RESULT_PAIR_RE, '')
            : originalLine;
        if (dropping) {
            if (NATIVE_TOOL_RESULT_CLOSE_RE.test(line)) dropping = false;
            continue;
        }
        if (line !== originalLine && line.trim() === '') continue;
        if (NATIVE_TOOL_RESULT_OPEN_RE.test(line)) {
            dropping = true;
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

const TOOL_RESULT_ECHO_RESIDUE_LIMIT = 0.5;

function isToolResultEcho(content) {
    const text = String(content == null ? '' : content);
    const stripped = stripToolResultEchoes(text);
    if (stripped === text) return false;

    const dense = s => s.replace(/\s+/g, '').length;
    const originalLen = dense(text);
    if (originalLen === 0) return false;

    return dense(stripped) < originalLen * TOOL_RESULT_ECHO_RESIDUE_LIMIT;
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

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
    isToolResultEcho,
    stripToolResultEchoes,
    isContextTooLongError,
    classifyRecoveryFailure,
    isUpstreamTransientError,
    isAuthExpiredError,
};
