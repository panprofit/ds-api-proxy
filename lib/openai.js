'use strict';
const crypto = require('crypto');
// OpenAI-compatible response builders and token estimation.
// Pure functions, no server state.

// Heuristic token estimator. There is no tokenizer dependency, so we
// approximate by character class: the ratio of characters to BPE tokens
// differs sharply between scripts. The weights below are intentionally
// conservative round numbers rather than a real vocabulary:
//   - ASCII/Latin: ~4 chars per token
//   - Cyrillic/Greek/Arabic/etc.: ~2 chars per token
//   - CJK (and other dense scripts): ~1 char per token (often <1)
//   - astral (emoji, rare CJK ext): counted as ~2 tokens each
// The result is only used for the `usage` field of a response, so a rough
// estimate that is directionally correct is enough; it is NOT billing-grade.
const TOKEN_CHARS = { ascii: 4, wide: 2, cjk: 1 };

function isCjkCodePoint(cp) {
    return (cp >= 0x2e80 && cp <= 0x9fff)   // CJK radicals .. unified ideographs
        || (cp >= 0xf900 && cp <= 0xfaff)   // CJK compatibility ideographs
        || (cp >= 0x3040 && cp <= 0x30ff)   // Hiragana + Katakana
        || (cp >= 0xac00 && cp <= 0xd7af)   // Hangul syllables
        || (cp >= 0x20000 && cp <= 0x2ffff); // CJK extension B..F (astral)
}

// Split text into weighted character counts per token class.
function countTokenClasses(text) {
    const value = String(text == null ? '' : text);
    let ascii = 0;
    let wide = 0;
    let cjk = 0;
    let astral = 0;
    for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) { ascii++; continue; }
        // Astral code points are billed as ~2 tokens regardless of script; do
        // not also count them as CJK to avoid double-counting.
        if (cp > 0xffff) { astral++; continue; }
        if (isCjkCodePoint(cp)) cjk++;
        else wide++;
    }
    return { ascii, wide, cjk, astral };
}

// Estimated token count for `text`. Sums the per-class contributions as real
// numbers and rounds ONCE at the end, instead of rounding each class up
// independently. Independent rounding systematically over-counted mixed text
// (e.g. a lone ASCII char in a mostly-CJK string rounded up to a full token on
// top of the CJK tokens). A non-empty input still never yields 0.
function estimateTokens(text) {
    const value = String(text == null ? '' : text);
    if (!value) return 0;
    const { ascii, wide, cjk, astral } = countTokenClasses(value);
    const tokens = (ascii / TOKEN_CHARS.ascii)
        + (wide / TOKEN_CHARS.wide)
        + (cjk / TOKEN_CHARS.cjk)
        + astral * 2; // each astral code point is ~2 tokens (1 surrogate pair + weight)
    return Math.max(1, Math.ceil(tokens));
}

// Build the usage block from an already-computed prompt token count.
// Used when the caller tracks the remote session's full context size itself
// (the session may only receive per-turn deltas), so the prompt is not
// re-estimated from a single monolithic string on every request.
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

// Default model name echoed in responses when the client did not send one.
// The proxy does not switch upstream models; it only reports the requested
// name back so strict OpenAI clients see their `model` field.
const DEFAULT_MODEL = 'deepseek-chat';

// Unique per-response id. crypto.randomUUID() avoids the millisecond
// collisions the old Date.now() timestamp hit under concurrent requests:
// two responses finishing in the same millisecond shared an id, which
// clients that dedupe or log by id would merge.
function responseId() { return 'ds-' + crypto.randomUUID(); }

function buildToolCallResponseFromTokens(toolCall, promptTokens = 0, reasoningContent = '', model = DEFAULT_MODEL) {
    // crypto.randomUUID() avoids the millisecond collisions the old
    // Date.now()+Math.random() id could hit under concurrent requests.
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

// Side-channel mitigation padding (OpenAI's `obfuscation` field).
//
// OpenAI pads every streaming chunk with a random base64 string so that an
// observer cannot infer response content from packet sizes alone. The target is
// a serialized chunk of ~512 chars; when the chunk (plus the `,"obfuscation":""`
// overhead) is already at/over the target, a minimum pad is still emitted so
// the field is always present.
const OBFUSCATION_TARGET_LEN = 512;
const OBFUSCATION_MIN_PAD = 16;

// Random base64 string of exactly `len` characters. `len` characters of base64
// need ceil(len*3/4) random bytes; the encode is then sliced to `len`.
function randomObfuscationPadding(len) {
    if (!len || len <= 0) return '';
    const byteLen = Math.ceil((len * 3) / 4);
    return crypto.randomBytes(byteLen).toString('base64').slice(0, len);
}

// Compute the pad length for a chunk whose JSON (without the obfuscation
// field) is `serializedLen` characters long. Mirrors the upstream behaviour.
function obfuscationPadLength(serializedLen) {
    const overhead = ',"obfuscation":""'.length;
    if (serializedLen + overhead < OBFUSCATION_TARGET_LEN) {
        return OBFUSCATION_TARGET_LEN - serializedLen - overhead;
    }
    return OBFUSCATION_MIN_PAD;
}

const STREAM_CHUNK_CODE_POINTS = 50;

// Split text into chunks without breaking surrogate pairs (astral code points).
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
