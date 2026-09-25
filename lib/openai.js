'use strict';
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

// Estimated token count for `text`. Rounds each class up independently so a
// non-empty input never yields 0, then sums.
function estimateTokens(text) {
    const value = String(text == null ? '' : text);
    if (!value) return 0;
    const { ascii, wide, cjk, astral } = countTokenClasses(value);
    const tokens = Math.ceil(ascii / TOKEN_CHARS.ascii)
        + Math.ceil(wide / TOKEN_CHARS.wide)
        + Math.ceil(cjk / TOKEN_CHARS.cjk)
        + astral * 2; // each astral code point is ~2 tokens (1 surrogate pair + weight)
    return Math.max(1, tokens);
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

function buildToolCallResponseFromTokens(toolCall, promptTokens = 0, reasoningContent = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
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
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsageFromTokens(promptTokens, '', reasoningContent),
    };
}

function buildTextResponseFromTokens(content, promptTokens, reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        choices: [{
            index: 0,
            message,
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsageFromTokens(promptTokens, content, reasoningContent),
    };
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
    buildToolCallResponseFromTokens,
    buildTextResponseFromTokens,
    splitIntoChunks,
    STREAM_CHUNK_CODE_POINTS,
};
