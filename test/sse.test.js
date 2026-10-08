'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDSResponse, debugSseEnabled, dumpSseEnabled, parseMutedBody } = require('../lib/sse');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Build an async-iterable of Uint8Array chunks from raw string pieces, so we can
// exercise arbitrary chunk boundaries (including splits inside a single line).
function streamOf(...chunks) {
    return {
        async *[Symbol.asyncIterator]() {
            const enc = new TextEncoder();
            for (const chunk of chunks) yield enc.encode(chunk);
        },
    };
}

// Wrap pre-encoded Uint8Array chunks without re-encoding them.
function byteStreamOf(chunks) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) yield chunk;
        },
    };
}

function sse(...events) {
    return events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
}

// Silent logger collector: returns { log, lines }.
function collectLog() {
    const lines = [];
    const log = (...args) => lines.push(args.join(' '));
    return { log, lines };
}

const SESSION = () => ({ parentMessageId: 'parent-0', messageCount: 0 });

// ---------------------------------------------------------------------------
// debugSseEnabled
// ---------------------------------------------------------------------------

test('debugSseEnabled: true for "1"/"true" (any case), false otherwise', () => {
    assert.equal(debugSseEnabled({ DS_DEBUG: '1' }), true);
    assert.equal(debugSseEnabled({ DS_DEBUG: 'TRUE' }), true);
    assert.equal(debugSseEnabled({ DS_DEBUG: 'true' }), true);
    assert.equal(debugSseEnabled({ DS_DEBUG: '0' }), false);
    assert.equal(debugSseEnabled({ DS_DEBUG: '' }), false);
    assert.equal(debugSseEnabled({}), false);
});

// ---------------------------------------------------------------------------
// basic content paths
// ---------------------------------------------------------------------------

test('readDSResponse: accumulates response/content fragments and message id', async () => {
    const session = SESSION();
    const { log } = collectLog();
    const body = sse(
        { p: 'response/message_id', v: 'msg-1' },
        { p: 'response/content', v: 'Hello' },
        { p: 'response/content', v: ', world' },
        { p: 'response/finish_reason', v: 'stop' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log });
    assert.equal(out.content, 'Hello, world');
    assert.equal(out.messageId, 'msg-1');
    assert.equal(out.finishReason, 'stop');
    assert.equal(session.parentMessageId, 'msg-1');
    assert.equal(session.messageCount, 1);
});

test('readDSResponse: response/fragments rebuilds content + reasoning', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response/fragments', v: { type: 'RESPONSE', content: 'Hel' } },
        { p: 'response/fragments', v: { type: 'THINK', content: 'think ' } },
        { p: 'response/fragments', v: { type: 'RESPONSE', content: 'lo' } },
        { response_message_id: 'msg-2' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.content, 'Hello');
    assert.equal(out.reasoningContent, 'think ');
    assert.equal(out.messageId, 'msg-2');
});

test('readDSResponse: response/fragments/-1/content appends to last fragment', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response/fragments', v: { type: 'RESPONSE', content: 'a' } },
        { p: 'response/fragments/-1/content', v: 'b' },
        { p: 'response/fragments/-1/content', v: 'c' },
        { response_message_id: 'm' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.content, 'abc');
});

test('readDSResponse: response/fragments/-1/content appends reasoning to the last fragment', async () => {
    // The append path has two branches (assistant output vs reasoning); the
    // RESPONSE branch is covered above, this locks in the THINK/REASONING one.
    const session = SESSION();
    const body = sse(
        { p: 'response/fragments', v: { type: 'THINK', content: 'th' } },
        { p: 'response/fragments/-1/content', v: 'ink' },
        { response_message_id: 'm' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.reasoningContent, 'think');
    assert.equal(out.content, '');
});

test('readDSResponse: response/fragments/-1/content with no fragments is ignored', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response/fragments/-1/content', v: 'orphan' },
        { response_message_id: 'm' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.content, '');
});

test('readDSResponse: full response snapshot (v.response) overrides content + fragments', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response/content', v: 'partial' },
        { p: 'response', v: { response: { message_id: 'snap-1', content: 'final text', fragments: [ { type: 'RESPONSE', content: 'final text' } ], finish_reason: 'stop' } } },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.content, 'final text');
    assert.equal(out.messageId, 'snap-1');
    assert.equal(out.finishReason, 'stop');
});

// ---------------------------------------------------------------------------
// patch operations (response path)
// ---------------------------------------------------------------------------

test('readDSResponse: response APPEND patch operations feed fragments', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response', v: [{ p: 'fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'x' } }] },
        { p: 'response', v: [{ p: 'fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'y' } }] },
        { response_message_id: 'm' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.content, 'xy');
});

test('readDSResponse: non-append response patches are ignored', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response', v: [{ p: 'fragments', o: 'REPLACE', v: { type: 'RESPONSE', content: 'nope' } }] },
        { response_message_id: 'm' },
    );
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.content, '');
});

// ---------------------------------------------------------------------------
// finish reason / status / model errors
// ---------------------------------------------------------------------------

test('readDSResponse: response/status non-FINISHED sets finishReason; FINISHED does not', async () => {
    const s1 = SESSION();
    const out1 = await readDSResponse(
        streamOf(sse({ p: 'response/status', v: 'STOPPED' }, { response_message_id: 'm' })),
        s1, '[t]', { log: () => {} },
    );
    assert.equal(out1.finishReason, 'STOPPED');

    const s2 = SESSION();
    const out2 = await readDSResponse(
        streamOf(sse({ p: 'response/status', v: 'FINISHED' }, { response_message_id: 'm' })),
        s2, '[t]', { log: () => {} },
    );
    assert.equal(out2.finishReason, null);
});

test('readDSResponse: top-level finish_reason is captured', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ finish_reason: 'length' }, { response_message_id: 'm' })),
        session, '[t]', { log: () => {} },
    );
    assert.equal(out.finishReason, 'length');
});

test('readDSResponse: model error event captured with fields', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ type: 'error', content: 'boom', finish_reason: 'error' }, { response_message_id: 'm' })),
        session, '[t]', { log: () => {} },
    );
    assert.deepEqual(out.modelError, { type: 'error', content: 'boom', finish_reason: 'error' });
});

test('readDSResponse: model error defaults finish_reason to null', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ type: 'error' }, { response_message_id: 'm' })),
        session, '[t]', { log: () => {} },
    );
    assert.deepEqual(out.modelError, { type: 'error', content: '', finish_reason: null });
});

test('readDSResponse: a model error does not advance the parent session', async () => {
    // generation_err / "Server temporarily unavailable." arrives with a
    // message id, but no usable assistant turn was produced. Advancing
    // parentMessageId to it would make a same-session retry branch off the
    // failed node, so the parent must stay put (and messageCount must not grow).
    const session = { parentMessageId: 'parent-0', messageCount: 3 };
    const out = await readDSResponse(
        streamOf(sse(
            { type: 'error', content: 'Server temporarily unavailable.', finish_reason: 'generation_err' },
            { response_message_id: 'failed-node' },
        )),
        session, '[t]', { log: () => {} },
    );
    assert.equal(out.messageId, 'failed-node');
    assert.equal(out.modelError.finish_reason, 'generation_err');
    assert.equal(session.parentMessageId, 'parent-0', 'parent must not advance on a model error');
    assert.equal(session.messageCount, 3);
});

// ---------------------------------------------------------------------------
// message id extraction fallbacks
// ---------------------------------------------------------------------------

test('readDSResponse: response_message_id wins over message_id', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ response_message_id: 'primary', message_id: 'secondary' })),
        session, '[t]', { log: () => {} },
    );
    assert.equal(out.messageId, 'primary');
});

test('readDSResponse: deep nested message id found via findMessageId sweep', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ some: { deep: { messageId: 'deep-1' } } })),
        session, '[t]', { log: () => {} },
    );
    assert.equal(out.messageId, 'deep-1');
});

test('readDSResponse: response/message_id object uses findMessageId', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ p: 'response/message_id', v: { data: { message_id: 'from-obj' } } })),
        session, '[t]', { log: () => {} },
    );
    assert.equal(out.messageId, 'from-obj');
});

// ---------------------------------------------------------------------------
// session mutation / missing id
// ---------------------------------------------------------------------------

test('readDSResponse: no id keeps parent session and warns, messageCount unchanged', async () => {
    const session = { parentMessageId: 'old-parent', messageCount: 5 };
    const { log, lines } = collectLog();
    const out = await readDSResponse(
        streamOf(sse({ p: 'response/content', v: 'text only' })),
        session, '[agent]', { log },
    );
    assert.equal(out.messageId, null);
    assert.equal(session.parentMessageId, 'old-parent');
    assert.equal(session.messageCount, 5);
    assert.ok(lines.some(l => l.includes('could not extract message_id')));
    assert.ok(lines.some(l => l.includes('keeping parent=old-parent')));
});

test('readDSResponse: null parent reported as null in warning', async () => {
    const session = { parentMessageId: null, messageCount: 0 };
    const { log, lines } = collectLog();
    await readDSResponse(streamOf(sse({})), session, '[agent]', { log });
    assert.ok(lines.some(l => l.includes('keeping parent=null')));
});

// ---------------------------------------------------------------------------
// malformed events / parse errors
// ---------------------------------------------------------------------------

test('readDSResponse: malformed JSON counted, stream continues', async () => {
    const session = SESSION();
    const { log, lines } = collectLog();
    const body = 'data: {not json\n\n' + sse({ p: 'response/content', v: 'ok' }, { response_message_id: 'm' });
    const out = await readDSResponse(streamOf(body), session, '[agent]', { log, debugSse: true });
    assert.equal(out.content, 'ok');
    assert.equal(out.messageId, 'm');
    assert.ok(lines.some(l => l.includes('1 unparseable event')));
    assert.ok(lines.some(l => l.includes('JSON.parse failed')));
});

test('readDSResponse: malformed JSON not logged when debugSse is false', async () => {
    const session = SESSION();
    const { log, lines } = collectLog();
    const body = 'data: nope\n\n' + sse({ response_message_id: 'm' });
    await readDSResponse(streamOf(body), session, '[agent]', { log, debugSse: false });
    assert.equal(lines.some(l => l.includes('JSON.parse failed')), false);
    assert.equal(lines.some(l => l.includes('unparseable event')), true);
});

// ---------------------------------------------------------------------------
// chunking / framing edge cases
// ---------------------------------------------------------------------------

test('readDSResponse: handles events split across arbitrary chunk boundaries', async () => {
    const session = SESSION();
    const body = sse(
        { p: 'response/content', v: 'ab' },
        { p: 'response/content', v: 'cd' },
        { response_message_id: 'split-m' },
    );
    // Split every 7 bytes, cutting through JSON and line boundaries.
    const enc = new TextEncoder();
    const bytes = enc.encode(body);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    const out = await readDSResponse(byteStreamOf(chunks), session, '[t]', { log: () => {} });
    assert.equal(out.content, 'abcd');
    assert.equal(out.messageId, 'split-m');
});

test('readDSResponse: ignores lines without data: prefix', async () => {
    const session = SESSION();
    const body = ': comment\nevent: ping\ndata: ' + JSON.stringify({ response_message_id: 'ok-m' }) + '\n\n';
    const out = await readDSResponse(streamOf(body), session, '[t]', { log: () => {} });
    assert.equal(out.messageId, 'ok-m');
});

test('readDSResponse: empty stream yields defaults and does not touch session', async () => {
    const session = { parentMessageId: 'p', messageCount: 2 };
    const out = await readDSResponse(streamOf(), session, '[t]', { log: () => {} });
    assert.deepEqual(
        { content: out.content, reasoningContent: out.reasoningContent, messageId: out.messageId, finishReason: out.finishReason, modelError: out.modelError },
        { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null },
    );
    assert.equal(session.parentMessageId, 'p');
    assert.equal(session.messageCount, 2);
});

test('readDSResponse: response/content ignores object values', async () => {
    const session = SESSION();
    const out = await readDSResponse(
        streamOf(sse({ p: 'response/content', v: { bad: true } }, { p: 'response/content', v: 'ok' }, { response_message_id: 'm' })),
        session, '[t]', { log: () => {} },
    );
    assert.equal(out.content, 'ok');
});

// ---------------------------------------------------------------------------
// combined scenario
// ---------------------------------------------------------------------------

test('readDSResponse: realistic mixed stream produces full result', async () => {
    const session = SESSION();
    const { log, lines } = collectLog();
    const body = sse(
        { p: 'response/fragments', v: { type: 'THINK', content: 'reasoning...' } },
        { p: 'response/fragments', v: { type: 'RESPONSE', content: 'Hi ' } },
        { p: 'response/fragments/-1/content', v: 'there' },
        { p: 'response/finish_reason', v: 'stop' },
        { p: 'response/status', v: 'FINISHED' },
        { response_message_id: 'final-1' },
    );
    const out = await readDSResponse(streamOf(body), session, '[agent]', { log, debugSse: true });
    assert.equal(out.content, 'Hi there');
    assert.equal(out.reasoningContent, 'reasoning...');
    assert.equal(out.finishReason, 'stop');
    assert.equal(out.messageId, 'final-1');
    assert.equal(out.modelError, null);
    assert.equal(session.parentMessageId, 'final-1');
    assert.equal(session.messageCount, 1);
    assert.equal(lines.length, 0, `unexpected log lines: ${lines.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// raw-stream diagnostic dump (DS_DUMP_SSE / dumpRawStream)
// ---------------------------------------------------------------------------

test('dumpSseEnabled: true for "1"/"true" (any case), false otherwise', () => {
    assert.equal(dumpSseEnabled({ DS_DUMP_SSE: '1' }), true);
    assert.equal(dumpSseEnabled({ DS_DUMP_SSE: 'TRUE' }), true);
    assert.equal(dumpSseEnabled({ DS_DUMP_SSE: 'true' }), true);
    assert.equal(dumpSseEnabled({ DS_DUMP_SSE: '0' }), false);
    assert.equal(dumpSseEnabled({ DS_DUMP_SSE: '' }), false);
    assert.equal(dumpSseEnabled({}), false);
});

test('readDSResponse: dumpRawStream logs each raw data line and a path summary', async () => {
    const session = SESSION();
    const { log, lines } = collectLog();
    const body = sse(
        { p: 'response/content', v: 'hi' },
        { p: 'response/has_pending_fragment', v: true },
        { response_message_id: 'm' },
    );
    const out = await readDSResponse(streamOf(body), session, '[agent]', { log, dumpRawStream: true });
    assert.equal(out.content, 'hi');
    assert.equal(lines.filter(l => l.includes('[SSE raw]')).length, 3);
    const summary = lines.find(l => l.includes('[SSE dump]'));
    assert.ok(summary, `missing dump summary in: ${lines.join(' | ')}`);
    assert.ok(summary.includes('response/content\u00d71'));
    assert.ok(summary.includes('response/has_pending_fragment\u00d71'));
    assert.ok(summary.includes('messageId=yes'));
});

test('readDSResponse: no raw dump by default', async () => {
    const session = SESSION();
    const { log, lines } = collectLog();
    const body = sse({ p: 'response/content', v: 'hi' }, { response_message_id: 'm' });
    await readDSResponse(streamOf(body), session, '[agent]', { log });
    assert.equal(lines.some(l => l.includes('[SSE raw]')), false);
    assert.equal(lines.some(l => l.includes('[SSE dump]')), false);
});

test('readDSResponse: dumpRawStream with zero parsed events logs a body preview', async () => {
    // events=0 cannot distinguish an empty stream from a non-SSE (WAF/HTML)
    // body, so the dump includes the first bytes of the raw response. A muted
    // JSON body is a realistic zero-event case that still yields `muted`.
    const session = SESSION();
    const { log, lines } = collectLog();
    const out = await readDSResponse(streamOf(MUTED_BODY), session, '[agent]', { log, dumpRawStream: true });
    assert.ok(out.muted, 'expected the muted payload to be detected');
    assert.equal(lines.some(l => l.includes('[SSE raw]')), false);
    const summary = lines.find(l => l.includes('[SSE dump]'));
    assert.ok(summary, `missing dump summary in: ${lines.join(' | ')}`);
    assert.ok(summary.includes('events=0'), `expected events=0 in: ${summary}`);
    const preview = lines.find(l => l.includes('no events received; raw body preview'));
    assert.ok(preview, `missing raw-body preview in: ${lines.join(' | ')}`);
    assert.ok(preview.includes('biz_code'), `expected the preview to carry the body: ${preview}`);
});

// ---------------------------------------------------------------------------
// muted-body detection
// ---------------------------------------------------------------------------

const MUTED_BODY = JSON.stringify({
    code: 0,
    msg: '',
    data: { biz_code: 5, biz_msg: 'user is muted', biz_data: { is_muted: 1, mute_until: 1791636413.054 } },
});

test('parseMutedBody: parses a DS user-is-muted payload', () => {
    const out = parseMutedBody(MUTED_BODY);
    assert.ok(out);
    assert.equal(out.message, 'user is muted');
    assert.equal(out.muteUntil, 1791636413.054);
});

test('parseMutedBody: ignores SSE bodies, other biz codes and invalid JSON', () => {
    assert.equal(parseMutedBody('data: {"v":1}\n\n'), null);
    assert.equal(parseMutedBody('{"code":0,"data":{"biz_code":1,"biz_msg":"ok"}}'), null);
    assert.equal(parseMutedBody('{"code":0,"data":{"biz_code":5,"biz_msg":"something else"}}'), null);
    assert.equal(parseMutedBody('not json'), null);
    assert.equal(parseMutedBody(''), null);
});

test('readDSResponse: a muted JSON body yields zero events and sets `muted`', async () => {
    const session = SESSION();
    const { log, lines } = collectLog();
    const out = await readDSResponse(streamOf(MUTED_BODY), session, '[agent]', { log });
    assert.equal(out.content, '');
    assert.equal(out.messageId, null);
    assert.ok(out.muted);
    assert.equal(out.muted.message, 'user is muted');
    assert.equal(out.muted.muteUntil, 1791636413.054);
    // The muted body never advances the remote session.
    assert.equal(session.parentMessageId, 'parent-0');
    assert.equal(session.messageCount, 0);
    assert.ok(lines.some(l => l.includes('DS account muted')));
});

test('readDSResponse: a normal empty stream is NOT flagged as muted', async () => {
    const session = SESSION();
    const out = await readDSResponse(streamOf(''), session, '[agent]', { log: () => {} });
    assert.equal(out.muted, null);
});

test('readDSResponse: a muted body split across chunks is still detected', async () => {
    const session = SESSION();
    const half = Math.floor(MUTED_BODY.length / 2);
    const out = await readDSResponse(
        streamOf(MUTED_BODY.slice(0, half), MUTED_BODY.slice(half)),
        session, '[agent]', { log: () => {} },
    );
    assert.ok(out.muted);
    assert.equal(out.muted.muteUntil, 1791636413.054);
});
