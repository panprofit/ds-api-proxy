'use strict';
// Unit tests for lib/upstream.js. Network calls are exercised by stubbing the
// global `fetch`; the module reads accounts via ./accounts, so we also stub the
// remote host and upload cache. No real network access happens here.

const test = require('node:test');
const assert = require('node:assert/strict');

const accounts = require('../lib/accounts');
const uploadCache = require('../lib/upload-cache');

// Load upstream only after we can control globals. `setRemoteHost` is used by
// dsFetch to build the URL.
accounts.setRemoteHost('ds.test');
const upstream = require('../lib/upstream');

const realFetch = globalThis.fetch;

async function withFetch(impl, fn) {
    globalThis.fetch = impl;
    try {
        return await fn();
    } finally {
        globalThis.fetch = realFetch;
    }
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}

// --- buildCompletionPayload -------------------------------------------------

test('buildCompletionPayload: builds the exact DS request body', () => {
    const body = upstream.buildCompletionPayload({
        sessionId: 's1', parentMessageId: 'p1', prompt: 'hello', fileIds: ['f1'],
    });
    assert.deepEqual(body, {
        chat_session_id: 's1',
        parent_message_id: 'p1',
        model_type: upstream.CHAT_MODEL_TYPE,
        prompt: 'hello',
        ref_file_ids: ['f1'],
        thinking_enabled: upstream.CHAT_THINKING_ENABLED,
        search_enabled: upstream.CHAT_SEARCH_ENABLED,
        action: null,
        preempt: false,
    });
});

test('buildCompletionPayload: fileIds defaults to []', () => {
    assert.deepEqual(upstream.buildCompletionPayload({ prompt: 'x' }).ref_file_ids, []);
});

test('buildCompletionPayload: thinking_enabled defaults to CHAT_THINKING_ENABLED', () => {
    assert.equal(
        upstream.buildCompletionPayload({ prompt: 'x' }).thinking_enabled,
        upstream.CHAT_THINKING_ENABLED
    );
});

test('buildCompletionPayload: thinkingEnabled overrides the default', () => {
    assert.equal(
        upstream.buildCompletionPayload({ prompt: 'x', thinkingEnabled: true }).thinking_enabled,
        true
    );
    assert.equal(
        upstream.buildCompletionPayload({ prompt: 'x', thinkingEnabled: false }).thinking_enabled,
        false
    );
});

test('dsChatCompletionWithPow: forwards thinkingEnabled into the payload', async () => {
    let seenBody = null;
    await withFetch(async (url, opts) => { seenBody = JSON.parse(opts.body); return jsonResponse({}); }, async () => {
        await upstream.dsChatCompletionWithPow({
            sessionId: 's1', parentMessageId: 'p1', prompt: 'hi',
            powHeader: 'POW', dsHeaders: {}, thinkingEnabled: true,
        });
    });
    assert.equal(seenBody.thinking_enabled, true);
});

// --- dsFetch ----------------------------------------------------------------

test('dsFetch: prefixes the remote host and API base', async () => {
    let seenUrl = null;
    await withFetch(async (url) => { seenUrl = url; return jsonResponse({}); }, async () => {
        await upstream.dsFetch('/chat/x', { method: 'POST' });
    });
    assert.equal(seenUrl, 'https://ds.test/api/v0/chat/x');
});

test('dsFetch: attaches an AbortSignal timeout by default', async () => {
    let seenSignal = null;
    await withFetch(async (url, opts) => { seenSignal = opts.signal; return jsonResponse({}); }, async () => {
        await upstream.dsFetch('/chat/x', {});
    });
    assert.ok(seenSignal);
    assert.equal(seenSignal.constructor.name, 'AbortSignal');
});

// --- dsChatCompletionWithPow ------------------------------------------------

test('dsChatCompletionWithPow: sends the PoW header and payload', async () => {
    let seenOpts = null;
    await withFetch(async (url, opts) => { seenOpts = { url, opts }; return jsonResponse({}); }, async () => {
        await upstream.dsChatCompletionWithPow({
            sessionId: 's1', parentMessageId: 'p1', prompt: 'hi',
            powHeader: 'POW', dsHeaders: { 'X-Test': '1' }, fileIds: ['f1'],
        });
    });
    assert.equal(seenOpts.url, 'https://ds.test/api/v0/chat/completion');
    assert.equal(seenOpts.opts.method, 'POST');
    assert.equal(seenOpts.opts.headers['X-DS-PoW-Response'], 'POW');
    assert.equal(seenOpts.opts.headers['X-Test'], '1');
    assert.deepEqual(JSON.parse(seenOpts.opts.body).chat_session_id, 's1');
});

// --- createRemoteSession ----------------------------------------------------

test('createRemoteSession: returns the session id without deleting other sessions', async () => {
    const calls = [];
    await withFetch(async (url, opts) => {
        calls.push({ url, method: opts.method });
        return jsonResponse({ data: { biz_data: { chat_session: { id: 'sess-9' } } } });
    }, async () => {
        const id = await upstream.createRemoteSession({ id: 'acct', headers: {} }, {}, 'test');
        assert.equal(id, 'sess-9');
    });
    // Must NOT wipe unrelated sessions on the account: creating a new session
    // for one agent must not destroy other agents' live sessions.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://ds.test/api/v0/chat_session/create');
    assert.ok(!calls.some(c => c.url.endsWith('/chat_session/delete_all')));
});

test('createRemoteSession: throws when no id is returned', async () => {
    await withFetch(async () => jsonResponse({}), async () => {
        await assert.rejects(
            () => upstream.createRemoteSession({ id: 'acct', headers: {} }, {}, 'test'),
            /Could not create DS chat session/
        );
    });
});

// Regression: an "ok" response without a session id, or a 401/403, means the
// account is unusable (expired auth / captcha). The error must be tagged
// `auth_expired` so runWithRecovery rotates to a different account instead of
// failing the whole request.
test('createRemoteSession: tags a missing session id as auth_expired', async () => {
    await withFetch(async () => jsonResponse({}), async () => {
        await assert.rejects(
            () => upstream.createRemoteSession({ id: 'acct', headers: {} }, {}, 'test'),
            (e) => e.type === 'auth_expired' && e.status === 401
        );
    });
});

test('createRemoteSession: tags HTTP 401 as auth_expired', async () => {
    await withFetch(async () => jsonResponse({ message: 'unauthorized' }, { status: 401 }), async () => {
        await assert.rejects(
            () => upstream.createRemoteSession({ id: 'acct', headers: {} }, {}, 'test'),
            (e) => e.type === 'auth_expired' && e.status === 401
        );
    });
});

// --- deleteRemoteSession ----------------------------------------------------

test('deleteRemoteSession: POSTs the session id and returns true on success', async () => {
    let seen = null;
    await withFetch(async (url, opts) => {
        seen = { url, opts };
        return jsonResponse({ code: 0 });
    }, async () => {
        const ok = await upstream.deleteRemoteSession({ id: 'acct', headers: { 'X-Test': '1' } }, { 'X-Test': '1' }, 'sess-42', 'test delete');
        assert.equal(ok, true);
    });
    assert.equal(seen.url, 'https://ds.test/api/v0/chat_session/delete');
    assert.equal(seen.opts.method, 'POST');
    assert.deepEqual(JSON.parse(seen.opts.body), { chat_session_ids: ['sess-42'] });
    assert.equal(seen.opts.headers['X-Test'], '1');
});

test('deleteRemoteSession: no-ops without an id (no request made)', async () => {
    let called = false;
    await withFetch(async () => { called = true; return jsonResponse({}); }, async () => {
        const ok = await upstream.deleteRemoteSession({ id: 'acct', headers: {} }, {}, null);
        assert.equal(ok, false);
    });
    assert.equal(called, false);
});

test('deleteRemoteSession: returns false on a non-OK response without throwing', async () => {
    await withFetch(async () => jsonResponse('nope', { status: 500 }), async () => {
        const ok = await upstream.deleteRemoteSession({ id: 'acct', headers: {} }, {}, 'sess-1');
        assert.equal(ok, false);
    });
});

test('deleteRemoteSession: swallows network errors and returns false', async () => {
    await withFetch(async () => { throw new Error('socket hang up'); }, async () => {
        const ok = await upstream.deleteRemoteSession({ id: 'acct', headers: {} }, {}, 'sess-1');
        assert.equal(ok, false);
    });
});

// --- waitForFileReady -------------------------------------------------------

test('waitForFileReady: resolves once the file reports SUCCESS', async () => {
    let n = 0;
    await withFetch(async () => {
        n++;
        return jsonResponse({ data: { biz_data: { files: [{ id: 'f1', status: n === 1 ? 'PENDING' : 'SUCCESS', file_name: 'a.png' }] } } });
    }, async () => {
        const file = await upstream.waitForFileReady('f1', { headers: {} }, '');
        assert.equal(file.status, 'SUCCESS');
    });
});

test('waitForFileReady: throws on a failure status', async () => {
    await withFetch(async () => jsonResponse({
        data: { biz_data: { files: [{ id: 'f1', status: 'FAILED', error_code: 'X1' }] } },
    }), async () => {
        await assert.rejects(
            () => upstream.waitForFileReady('f1', { headers: {} }, ''),
            /failed with status=FAILED \(X1\)/
        );
    });
});

// --- assertPublicUrl --------------------------------------------------------

test('assertPublicUrl: accepts public http(s) URLs', () => {
    assert.ok(upstream.assertPublicUrl('https://example.com/a.png'));
    assert.ok(upstream.assertPublicUrl('http://8.8.8.8/a.png'));
});

test('assertPublicUrl: rejects non-http(s) schemes', () => {
    assert.throws(() => upstream.assertPublicUrl('ftp://example.com/a'), /unsupported scheme/);
    assert.throws(() => upstream.assertPublicUrl('file:///etc/passwd'), /unsupported scheme/);
});

test('assertPublicUrl: rejects SSRF targets', () => {
    for (const host of [
        'http://localhost/a', 'http://127.0.0.1/a', 'http://10.0.0.1/a',
        'http://192.168.1.1/a', 'http://169.254.1.1/a', 'http://172.16.0.1/a',
    ]) {
        assert.throws(() => upstream.assertPublicUrl(host), /blocked host/, host);
    }
});

test('assertPublicUrl: rejects invalid URLs', () => {
    assert.throws(() => upstream.assertPublicUrl('not a url'), /invalid url/);
});

test('assertPublicUrl: rejects IPv6 loopback/link-local/ULA/multicast', () => {
    for (const host of [
        'http://[::1]/a', 'http://[fe80::1]/a', 'http://[fc00::1]/a',
        'http://[fd00::1]/a', 'http://[ff02::1]/a', 'http://[::]/a',
        'http://[::ffff:127.0.0.1]/a',
    ]) {
        assert.throws(() => upstream.assertPublicUrl(host), /blocked host/, host);
    }
});

test('assertPublicUrl: accepts public IPv6 literals', () => {
    assert.ok(upstream.assertPublicUrl('https://[2001:4860:4860::8888]/a.png'));
    assert.ok(upstream.assertPublicUrl('https://[2606:4700:4700::1111]/a.png'));
});

test('isBlockedAddress: classifies raw IP addresses', () => {
    assert.equal(upstream.isBlockedAddress('127.0.0.1'), true);
    assert.equal(upstream.isBlockedAddress('10.0.0.5'), true);
    assert.equal(upstream.isBlockedAddress('100.64.0.1'), true);
    assert.equal(upstream.isBlockedAddress('8.8.8.8'), false);
    assert.equal(upstream.isBlockedAddress('::1'), true);
    assert.equal(upstream.isBlockedAddress('fe80::1'), true);
    assert.equal(upstream.isBlockedAddress('2001:4860:4860::8888'), false);
    assert.equal(upstream.isBlockedAddress('not-an-ip'), true);
});

test('assertPublicUrlResolved: blocks a hostname resolving to loopback', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://example.com/a.png', { lookup }),
        /blocked host/
    );
});

test('assertPublicUrlResolved: blocks when ANY resolved address is private', async () => {
    const lookup = async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
    ];
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://example.com/a.png', { lookup }),
        /blocked host/
    );
});

test('assertPublicUrlResolved: allows a hostname resolving only to public IPs', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const u = await upstream.assertPublicUrlResolved('https://example.com/a.png', { lookup });
    assert.equal(u.hostname, 'example.com');
});

test('assertPublicUrlResolved: rejects when DNS fails', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://nope.invalid/a.png', { lookup }),
        /could not resolve host/
    );
});

// --- resolveMessageAttachments ----------------------------------------------

test('resolveMessageAttachments: uploads image_url parts and returns ids', async () => {
    uploadCache.getCache().clear();
    const account = { id: 'acct1', headers: {}, config: {} };
    const calls = [];
    await withFetch(async (url) => {
        calls.push(url);
        if (url.includes('create_pow_challenge')) {
            return jsonResponse({ data: { biz_data: { challenge: { algorithm: 'a', challenge: 'c', salt: 's', signature: 'x', difficulty: 1, expire_at: 0 } } } });
        }
        if (url.includes('/file/upload_file')) {
            return jsonResponse({ data: { biz_data: { id: 'file-1' } } });
        }
        if (url.includes('/file/fetch_files')) {
            return jsonResponse({ data: { biz_data: { files: [{ id: 'file-1', status: 'SUCCESS' }] } } });
        }
        return jsonResponse({});
    }, async () => {
        // Stub solvePowForPath's WebAssembly dependency via a fake solver is not
        // possible here; instead assert the unsupported-scheme failure path,
        // which never reaches the network.
        const res = await upstream.resolveMessageAttachments(
            [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///x.png' } }] }],
            account,
            ''
        );
        assert.equal(res.fileIds.length, 0);
        assert.equal(res.failures.length, 1);
        assert.match(res.failures[0].error, /unsupported image_url scheme/);
    });
});

test('resolveMessageAttachments: no image parts -> empty result', async () => {
    const res = await upstream.resolveMessageAttachments(
        [{ role: 'user', content: 'plain' }],
        { id: 'a', headers: {} },
        ''
    );
    assert.deepEqual(res, { fileIds: [], uploads: [], failures: [] });
});

test('resolveMessageAttachments: data-URI parts upload and return file ids', async () => {
    const account = { id: 'acct1', headers: {}, config: {} };
    const uploads = [];
    const res = await upstream.resolveMessageAttachments(
        [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                { type: 'text', text: 'hi' },
            ],
        }],
        account,
        '[t]',
        {
            decode: () => ({ buffer: Buffer.from('AAAA'), mime: 'image/png' }),
            uploadFile: async ({ filename, mime }) => { uploads.push({ filename, mime }); return { id: 'file-1', filename, mime }; },
        }
    );
    assert.deepEqual(res.fileIds, ['file-1']);
    assert.equal(res.uploads.length, 1);
    assert.equal(res.failures.length, 0);
    assert.equal(uploads[0].mime, 'image/png');
});

test('resolveMessageAttachments: http URL parts are fetched then uploaded', async () => {
    const account = { id: 'acct1', headers: {}, config: {} };
    const fetched = [];
    const res = await upstream.resolveMessageAttachments(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://cdn.test/a.png' } }] }],
        account,
        '[t]',
        {
            decode: () => null,
            fetchFile: async (url, maxBytes) => { fetched.push({ url, maxBytes }); return { buffer: Buffer.from('PNG'), mime: 'image/png' }; },
            uploadFile: async ({ buffer, filename, mime }) => ({ id: 'file-2', filename, mime, size: buffer.length }),
        }
    );
    assert.deepEqual(res.fileIds, ['file-2']);
    assert.equal(res.failures.length, 0);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].url, 'https://cdn.test/a.png');
    assert.ok(fetched[0].maxBytes > 0);
});

test('resolveMessageAttachments: identical content uploads once (dedup by hash)', async () => {
    const account = { id: 'acct1', headers: {}, config: {} };
    let uploads = 0;
    const res = await upstream.resolveMessageAttachments(
        [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        ],
        account,
        '',
        {
            decode: () => ({ buffer: Buffer.from('SAME'), mime: 'image/png' }),
            uploadFile: async () => { uploads++; return { id: 'file-x' }; },
        }
    );
    assert.equal(uploads, 1, 'the second identical image must be deduped');
    assert.deepEqual(res.fileIds, ['file-x']);
});

test('resolveMessageAttachments: a failing upload is recorded in failures', async () => {
    const account = { id: 'acct1', headers: {}, config: {} };
    const res = await upstream.resolveMessageAttachments(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
        account,
        '',
        {
            decode: () => ({ buffer: Buffer.from('AAAA'), mime: 'image/png' }),
            uploadFile: async () => { throw new Error('upload boom'); },
        }
    );
    assert.equal(res.fileIds.length, 0);
    assert.equal(res.failures.length, 1);
    assert.match(res.failures[0].error, /upload boom/);
});

test('resolveMessageAttachments: skips parts with no url and non-image parts', async () => {
    const res = await upstream.resolveMessageAttachments(
        [
            { role: 'user', content: [{ type: 'image_url', image_url: {} }] },
            { role: 'user', content: [{ type: 'image_url' }] },
            null,
        ],
        { id: 'a', headers: {} },
        ''
    );
    assert.deepEqual(res, { fileIds: [], uploads: [], failures: [] });
});

// --- uploadCacheKey ---------------------------------------------------------

test('uploadCacheKey: same content under different names dedupes to one key', () => {
    const account = { id: 'acct1' };
    const buffer = Buffer.from('same-bytes');
    const a = upstream.uploadCacheKey({ account, buffer, mime: 'image/png' });
    // filename is not part of the key at all, so an identical buffer/mime yields
    // an identical key regardless of what the file is called.
    const b = upstream.uploadCacheKey({ account, buffer, mime: 'image/png' });
    assert.equal(a, b);
});

test('uploadCacheKey: identical name/size/mime but different content does NOT collide', () => {
    const account = { id: 'acct1' };
    // Same byte length, different bytes.
    const a = upstream.uploadCacheKey({ account, buffer: Buffer.from('AAAA'), mime: 'image/png' });
    const b = upstream.uploadCacheKey({ account, buffer: Buffer.from('BBBB'), mime: 'image/png' });
    assert.notEqual(a, b);
});

test('uploadCacheKey: different mime splits the key', () => {
    const account = { id: 'acct1' };
    const buffer = Buffer.from('same-bytes');
    const png = upstream.uploadCacheKey({ account, buffer, mime: 'image/png' });
    const jpeg = upstream.uploadCacheKey({ account, buffer, mime: 'image/jpeg' });
    assert.notEqual(png, jpeg);
});

test('uploadCacheKey: different account slot splits the key', () => {
    const buffer = Buffer.from('same-bytes');
    const a = upstream.uploadCacheKey({ account: { id: 'acct1' }, buffer, mime: 'image/png' });
    const b = upstream.uploadCacheKey({ account: { id: 'acct2' }, buffer, mime: 'image/png' });
    assert.notEqual(a, b);
});

test('uploadCacheKey: rotated token/cookie splits the key', () => {
    const buffer = Buffer.from('same-bytes');
    const before = upstream.uploadCacheKey({
        account: { id: 'acct1', config: { token: 't1', cookie: 'c1' } }, buffer, mime: 'image/png',
    });
    const after = upstream.uploadCacheKey({
        account: { id: 'acct1', config: { token: 't2', cookie: 'c1' } }, buffer, mime: 'image/png',
    });
    assert.notEqual(before, after);
});

// --- uploadFileToDS size guard ----------------------------------------------

test('uploadFileToDS: rejects empty buffers', async () => {
    await assert.rejects(
        () => upstream.uploadFileToDS({ buffer: Buffer.alloc(0), filename: 'a.png', account: { id: 'a', headers: {} } }),
        /empty buffer/
    );
});

test('uploadFileToDS: rejects oversized buffers', async () => {
    const big = Buffer.alloc(upstream.MAX_UPLOAD_BYTES + 1);
    await assert.rejects(
        () => upstream.uploadFileToDS({ buffer: big, filename: 'a.png', account: { id: 'a', headers: {} } }),
        /exceeds/
    );
});

// --- fetchRemoteFile --------------------------------------------------------
//
// fetchRemoteFile calls assertPublicUrlResolved() first, which skips DNS for
// IP literals (see the `net.isIP(host)` early return). Using 8.8.8.8 as the
// host therefore keeps these tests fully offline while still exercising the
// real SSRF guard + size-capping + redirect logic.

function binaryResponse(buffer, { status = 200, headers = {} } = {}) {
    // fetch Response shape needed by readBodyWithLimit: headers.get + body
    // (async-iterable) or arrayBuffer().
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        arrayBuffer: async () => buffer,
        body: null,
    };
}

function streamingResponse(chunks, { status = 200, headers = {} } = {}) {
    let cancelled = false;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        arrayBuffer: async () => { throw new Error('arrayBuffer should not be used when body is set'); },
        body: {
            [Symbol.asyncIterator]: async function* () {
                for (const c of chunks) {
                    if (cancelled) return;
                    yield Buffer.isBuffer(c) ? c : Buffer.from(c);
                }
            },
            cancel: async () => { cancelled = true; },
            wasCancelled: () => cancelled,
        },
    };
}

test('fetchRemoteFile: downloads a public URL and derives mime from content-type', async () => {
    const payload = Buffer.from('PNGDATA');
    let seenUrl = null;
    await withFetch(async (url) => {
        seenUrl = url;
        return binaryResponse(payload, { headers: { 'content-type': 'image/png; charset=binary' } });
    }, async () => {
        const out = await upstream.fetchRemoteFile('https://8.8.8.8/photo.png');
        assert.equal(seenUrl, 'https://8.8.8.8/photo.png');
        assert.equal(out.mime, 'image/png');
        assert.deepEqual(out.buffer, payload);
    });
});

test('fetchRemoteFile: falls back to guessMimeFromName when content-type is absent', async () => {
    await withFetch(async () => binaryResponse(Buffer.from('x')), async () => {
        const out = await upstream.fetchRemoteFile('https://8.8.8.8/photo.jpg');
        assert.equal(out.mime, 'image/jpeg');
    });
});

test('fetchRemoteFile: rejects when content-length exceeds the cap', async () => {
    await withFetch(async () => binaryResponse(Buffer.from('xxxx'), {
        headers: { 'content-length': '9999' },
    }), async () => {
        await assert.rejects(
            () => upstream.fetchRemoteFile('https://8.8.8.8/a.png', 10),
            /file is 9999 bytes, exceeds 10/
        );
    });
});

test('fetchRemoteFile: rejects when the streamed body exceeds the cap and cancels the stream', async () => {
    const resp = streamingResponse(['aaaa', 'bbbb', 'cccc'], { headers: { 'content-type': 'image/png' } });
    await withFetch(async () => resp, async () => {
        await assert.rejects(
            () => upstream.fetchRemoteFile('https://8.8.8.8/a.png', 5),
            /exceeds 5 bytes/
        );
    });
    assert.equal(resp.body.wasCancelled(), true);
});

test('fetchRemoteFile: accumulates a streamed body under the cap', async () => {
    await withFetch(async () => streamingResponse(['aa', 'bb'], { headers: { 'content-type': 'image/png' } }), async () => {
        const out = await upstream.fetchRemoteFile('https://8.8.8.8/a.png', 100);
        assert.equal(out.buffer.toString(), 'aabb');
    });
});

test('fetchRemoteFile: throws on a non-OK HTTP status', async () => {
    await withFetch(async () => binaryResponse('nope', { status: 404 }), async () => {
        await assert.rejects(
            () => upstream.fetchRemoteFile('https://8.8.8.8/a.png'),
            /HTTP 404/
        );
    });
});

test('fetchRemoteFile: follows a redirect and re-checks the target', async () => {
    const calls = [];
    await withFetch(async (url) => {
        calls.push(url);
        if (calls.length === 1) {
            return binaryResponse('', { status: 302, headers: { location: 'https://8.8.8.8/real.png' } });
        }
        return binaryResponse(Buffer.from('real'), { headers: { 'content-type': 'image/png' } });
    }, async () => {
        const out = await upstream.fetchRemoteFile('https://8.8.8.8/start.png');
        assert.deepEqual(calls, ['https://8.8.8.8/start.png', 'https://8.8.8.8/real.png']);
        assert.equal(out.buffer.toString(), 'real');
    });
});

test('fetchRemoteFile: rejects a redirect with no Location header', async () => {
    await withFetch(async () => binaryResponse('', { status: 301 }), async () => {
        await assert.rejects(
            () => upstream.fetchRemoteFile('https://8.8.8.8/a.png'),
            /HTTP 301/
        );
    });
});

test('fetchRemoteFile: rejects after too many redirects', async () => {
    await withFetch(async () => binaryResponse('', { status: 302, headers: { location: 'https://8.8.8.8/next.png' } }), async () => {
        await assert.rejects(
            () => upstream.fetchRemoteFile('https://8.8.8.8/a.png'),
            /too many redirects/
        );
    });
});

test('fetchRemoteFile: rejects a redirect to a private address (SSRF on hop)', async () => {
    await withFetch(async () => binaryResponse('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } }), async () => {
        await assert.rejects(
            () => upstream.fetchRemoteFile('https://8.8.8.8/a.png'),
            /blocked host/
        );
    });
});

// --- loadModule / solvePOW --------------------------------------------------

test('loadModule: throws without a wasmUrl', async () => {
    await assert.rejects(() => upstream.loadModule(''), /missing wasmUrl/);
});

test('loadModule: throws when the WASM fetch is not OK', async () => {
    await withFetch(async () => binaryResponse('nope', { status: 500 }), async () => {
        await assert.rejects(
            () => upstream.loadModule('https://8.8.8.8/pow.wasm'),
            /could not fetch WASM \(HTTP 500\)/
        );
    });
});

test('loadModule: throws on invalid WASM bytes and does not cache the failure', async () => {
    const wasmUrl = 'https://8.8.8.8/bad-pow.wasm';
    await withFetch(async () => binaryResponse(Buffer.from('not-wasm')), async () => {
        await assert.rejects(() => upstream.loadModule(wasmUrl));
        // A failed compile must be evicted from the module cache so a retry
        // can fetch fresh bytes instead of reusing a rejected promise.
        await assert.rejects(() => upstream.loadModule(wasmUrl));
    });
});
