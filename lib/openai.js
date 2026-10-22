'use strict';
const crypto = require('crypto');

const TOKEN_CHARS = { ascii: 4, wide: 2, cjk: 1 };

function isCjkCodePoint(cp) {
    return (cp >= 0x2e80 && cp <= 0x9fff)
        || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0x3040 && cp <= 0x30ff)
        || (cp >= 0xac00 && cp <= 0xd7af)
        || (cp >= 0x20000 && cp <= 0x2ffff);
}

function countTokenClasses(text) {
    const value = String(text == null ? '' : text);
    let ascii = 0;
    let wide = 0;
    let cjk = 0;
    let astral = 0;
    for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) { ascii++; continue; }

        if (cp > 0xffff) { astral++; continue; }
        if (isCjkCodePoint(cp)) cjk++;
        else wide++;
    }
    return { ascii, wide, cjk, astral };
}

function estimateTokens(text) {
    const value = String(text == null ? '' : text);
    if (!value) return 0;
    const { ascii, wide, cjk, astral } = countTokenClasses(value);
    const tokens = (ascii / TOKEN_CHARS.ascii)
        + (wide / TOKEN_CHARS.wide)
        + (cjk / TOKEN_CHARS.cjk)
        + astral * 2;
    return Math.max(1, Math.ceil(tokens));
}

function buildUsageFromTokens(promptTokens, content, reasoningContent = '') {
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

const DEFAULT_MODEL = 'default';

function responseId() { return 'ds-' + crypto.randomUUID(); }

function buildToolCallResponseFromTokens(toolCall, promptTokens = 0, reasoningContent = '', model = DEFAULT_MODEL) {

    const id = 'call_' + crypto.randomUUID();
    const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments }
        }]
    };
    return {
        id: responseId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || DEFAULT_MODEL,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsageFromTokens(promptTokens, '', reasoningContent),
    };
}

function buildTextResponseFromTokens(content, promptTokens, reasoningContent = '', finishReason = null, model = DEFAULT_MODEL) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: responseId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || DEFAULT_MODEL,
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsageFromTokens(promptTokens, content, reasoningContent),
    };
}

const OBFUSCATION_TARGET_LEN = 512;
const OBFUSCATION_MIN_PAD = 16;

function randomObfuscationPadding(len) {
    if (!len || len <= 0) return '';
    const byteLen = Math.ceil((len * 3) / 4);
    return crypto.randomBytes(byteLen).toString('base64').slice(0, len);
}

function obfuscationPadLength(serializedLen) {
    const overhead = ',"obfuscation":""'.length;
    if (serializedLen + overhead < OBFUSCATION_TARGET_LEN) {
        return OBFUSCATION_TARGET_LEN - serializedLen - overhead;
    }
    return OBFUSCATION_MIN_PAD;
}

const STREAM_CHUNK_CODE_POINTS = 50;

function splitIntoChunks(text, size = STREAM_CHUNK_CODE_POINTS) {
    const value = String(text == null ? '' : text);
    if (!value) return [];
    const chars = Array.from(value);
    const chunks = [];
    for (let i = 0; i < chars.length; i += size) {
        chunks.push(chars.slice(i, i + size).join(''));
    }
    return chunks;
}

module.exports = {
    TOKEN_CHARS,
    isCjkCodePoint,
    countTokenClasses,
    estimateTokens,
    buildUsageFromTokens,
    DEFAULT_MODEL,
    buildToolCallResponseFromTokens,
    buildTextResponseFromTokens,
    splitIntoChunks,
    STREAM_CHUNK_CODE_POINTS,
    OBFUSCATION_TARGET_LEN,
    OBFUSCATION_MIN_PAD,
    randomObfuscationPadding,
    obfuscationPadLength,
};
