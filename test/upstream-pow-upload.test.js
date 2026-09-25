'use strict';
// Coverage-focused tests for the PoW challenge solver and the attachment
// upload path in lib/upstream.js. Those branches were previously reachable
// only through higher-level flows, so they sat uncovered. A tiny real WASM
// module (POW_WASM_HEX) stubs the pow-wasm ABI solvePOW() calls, which lets
// solvePOW()/solvePowForPath()/uploadFileToDS() run end-to-end with only the
// global fetch stubbed — no network and no production wasm.

const test = require('node:test');
const assert = require('node:assert/strict');

const accounts = require('../lib/accounts');
const uploadCache = require('../lib/upload-cache');

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

// Minimal valid WASM exposing the three exports solvePOW() uses:
//   __wbindgen_export_0(n, align) -> 16   (a scratch pointer)
//   __wbindgen_add_to_stack_pointer(d) -> 0
//   wasm_solve(sp, cP, lC, pP, lP, difficulty) -> writes code=1, answer=42.0
// Built once by hand and committed as a constant so the test stays
// dependency-free.
const POW_WASM_HEX =
    '0061736d0100000001150360027f7f017f60017f017f60067f7f7f7f7f7f000304030001020503010001' +
    '074f04066d656d6f72790200135f5f7762696e6467656e5f6578706f72745f3000001f5f5f7762696e64' +
    '67656e5f6164645f746f5f737461636b5f706f696e74657200010a7761736d5f736f6c766500020a2603' +
    '040041100b040041000b1a0020004101360200200041086a4400000000000045403903000b';
const POW_WASM_BYTES = Buffer.from(POW_WASM_HEX, 'hex');

function wasmResponse() {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => POW_WASM_BYTES,
    };
}

function powChallenge() {
    return {
        data: {
            biz_data: {
                challenge: {
                    algorithm: 'DeepSeekHashV1',
                    challenge: 'abc',
                    salt: 's',
                    signature: 'sig',
                    difficulty: 1,
                    expire_at: 9_999_999_999,
                },
            },
        },
    };
}

// --- readDSJsonResponse -----------------------------------------------------

test('readDSJsonResponse: an empty body yields json=null without throwing', async () => {
    const out = await upstream.readDSJsonResponse(jsonResponse('', { status: 200 }), 'create', { id: 'a', failures: 0 });
    assert.equal(out.json, null);
    assert.equal(out.text, '');
});

test('readDSJsonResponse: a non-JSON body marks the account and throws', async () => {
    const account = { id: 'acct', failures: 0, cooldownUntil: 0 };
    await assert.rejects(
        () => upstream.readDSJsonResponse(jsonResponse('<<html>>', { status: 200 }), 'create', account),
        /non-JSON create response/
    );
    assert.equal(account.failures, 1);
});

// --- dsChatCompletion -------------------------------------------------------

test('dsChatCompletion: derives the PoW header from challenge/answer and sends the payload', async () => {
    let seen = null;
    await withFetch(async (url, opts) => { seen = { url, opts }; return jsonResponse({}); }, async () => {
        await upstream.dsChatCompletion({
            sessionId: 's1', parentMessageId: 'p1', prompt: 'hi',
            challenge: { algorithm: 'a', challenge: 'c', salt: 's', signature: 'x' },
            answer: 7, dsHeaders: { 'X-T': '1' },
        });
    });
    assert.equal(seen.url, 'https://ds.test/api/v0/chat/completion');
    assert.equal(seen.opts.method, 'POST');
    const header = JSON.parse(Buffer.from(seen.opts.headers['X-DS-PoW-Response'], 'base64').toString());
    assert.equal(header.answer, 7);
    assert.equal(header.target_path, '/api/v0/chat/completion');
    assert.equal(JSON.parse(seen.opts.body).chat_session_id, 's1');
});

// --- solvePowForPath / solvePOW --------------------------------------------

test('solvePowForPath: solves the challenge and returns a base64 PoW header', async () => {
    const calls = [];
    const account = { id: 'acct', headers: { 'X-A': '1' }, config: { wasmUrl: 'https://cdn.test/pow-success.wasm' } };
    let header;
    await withFetch(async (url) => {
        calls.push(url);
        if (url.endsWith('/chat/create_pow_challenge')) return jsonResponse(powChallenge());
        if (url === 'https://cdn.test/pow-success.wasm') return wasmResponse();
        throw new Error(`unexpected url ${url}`);
    }, async () => {
        header = await upstream.solvePowForPath(account, account.headers, '/api/v0/chat/completion', 'completion');
    });
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    assert.equal(decoded.answer, 42, 'answer comes from the wasm (floored)');
    assert.equal(decoded.challenge, 'abc');
    assert.equal(decoded.target_path, '/api/v0/chat/completion');
    assert.ok(calls.some(u => u.endsWith('/chat/create_pow_challenge')));
});

test('solvePowForPath: a non-OK challenge response marks the account and throws', async () => {
    const account = { id: 'acct', headers: {}, failures: 0, cooldownUntil: 0, config: {} };
    await withFetch(async () => jsonResponse('nope', { status: 500 }), async () => {
        await assert.rejects(() => upstream.solvePowForPath(account, {}, '/x', 'x'), /HTTP 500/);
    });
    assert.equal(account.failures, 1);
});

test('solvePowForPath: a non-JSON challenge body throws', async () => {
    const account = { id: 'acct', headers: {}, failures: 0, config: {} };
    await withFetch(async () => jsonResponse('not json'), async () => {
        await assert.rejects(() => upstream.solvePowForPath(account, {}, '/x', 'x'), /non-JSON PoW response/);
    });
});

test('solvePowForPath: a challenge-less response is tagged auth_expired', async () => {
    const account = { id: 'acct', headers: {}, failures: 0, config: {} };
    await withFetch(async () => jsonResponse({ data: { biz_data: {} } }), async () => {
        await assert.rejects(
            () => upstream.solvePowForPath(account, {}, '/x', 'x'),
            (e) => e.type === 'auth_expired' && e.status === 401
        );
    });
});

test('solvePowForPath: a missing wasmUrl throws with guidance', async () => {
    const account = { id: 'acct', headers: {}, config: {} };
    await withFetch(async () => jsonResponse(powChallenge()), async () => {
        await assert.rejects(() => upstream.solvePowForPath(account, {}, '/x', 'x'), /WASM URL is missing/);
    });
});

// --- deleteRemoteSession: 401 cooldown --------------------------------------

test('deleteRemoteSession: a 401 marks the account for cooldown', async () => {
    const account = { id: 'acct', failures: 0, cooldownUntil: 0 };
    await withFetch(async () => jsonResponse('unauthorized', { status: 401, headers: { 'retry-after': '3' } }), async () => {
        const ok = await upstream.deleteRemoteSession(account, {}, 'sess-1', 'test delete');
        assert.equal(ok, false);
    });
    assert.equal(account.failures, 1);
    assert.ok(account.cooldownUntil > Date.now());
});

// --- buildUploadBody / uploadFileToDS ---------------------------------------

test('buildUploadBody: puts the buffer in the `file` field with the filename', async () => {
    const form = await upstream.buildUploadBody(Buffer.from('data'), 'a.png', 'image/png');
    assert.ok(form instanceof FormData);
    const file = form.get('file');
    assert.ok(file instanceof Blob);
    assert.equal(file.type, 'image/png');
    assert.equal(file.name, 'a.png');
});

test('uploadFileToDS: uploads, polls to SUCCESS, and serves the second call from cache', async () => {
    uploadCache.getCache().clear();
    const account = {
        id: 'acct-up',
        headers: { 'Content-Type': 'application/json', 'X-A': '1' },
        config: { wasmUrl: 'https://cdn.test/pow-upload.wasm', token: 't', cookie: 'c' },
    };
    const calls = [];
    await withFetch(async (url) => {
        calls.push(url);
        if (url.endsWith('/chat/create_pow_challenge')) return jsonResponse(powChallenge());
        if (url === 'https://cdn.test/pow-upload.wasm') return wasmResponse();
        if (url.endsWith('/file/upload_file')) return jsonResponse({ data: { biz_data: { id: 'file-1' } } });
        if (url.includes('/file/fetch_files')) {
            return jsonResponse({ data: { biz_data: { files: [{ id: 'file-1', status: 'SUCCESS', file_name: 'a.png' }] } } });
        }
        throw new Error(`unexpected url ${url}`);
    }, async () => {
        const res = await upstream.uploadFileToDS({ buffer: Buffer.from('PNG'), filename: 'a.png', mime: 'image/png', account, agentTag: '[t]' });
        assert.equal(res.id, 'file-1');
        assert.equal(res.file.status, 'SUCCESS');
    });
    assert.equal(calls.filter(u => u.endsWith('/file/upload_file')).length, 1);

    // Second identical upload must hit the cache: no further fetch.
    const res2 = await upstream.uploadFileToDS({ buffer: Buffer.from('PNG'), filename: 'a.png', mime: 'image/png', account });
    assert.equal(res2.id, 'file-1');
});

test('uploadFileToDS: a 401 upload marks the account and throws', async () => {
    uploadCache.getCache().clear();
    const account = {
        id: 'acct-up401', headers: {}, failures: 0, cooldownUntil: 0,
        config: { wasmUrl: 'https://cdn.test/pow-upload-401.wasm' },
    };
    await withFetch(async (url) => {
        if (url.endsWith('/chat/create_pow_challenge')) return jsonResponse(powChallenge());
        if (url === 'https://cdn.test/pow-upload-401.wasm') return wasmResponse();
        if (url.endsWith('/file/upload_file')) return jsonResponse('nope', { status: 401, headers: { 'retry-after': '2' } });
        throw new Error(`unexpected url ${url}`);
    }, async () => {
        await assert.rejects(
            () => upstream.uploadFileToDS({ buffer: Buffer.from('PNG'), filename: 'a.png', mime: 'image/png', account }),
            /upload HTTP 401/
        );
    });
    assert.equal(account.failures, 1);
});

test('uploadFileToDS: a response without a file id throws', async () => {
    uploadCache.getCache().clear();
    const account = { id: 'acct-upnoid', headers: {}, config: { wasmUrl: 'https://cdn.test/pow-upload-noid.wasm' } };
    await withFetch(async (url) => {
        if (url.endsWith('/chat/create_pow_challenge')) return jsonResponse(powChallenge());
        if (url === 'https://cdn.test/pow-upload-noid.wasm') return wasmResponse();
        if (url.endsWith('/file/upload_file')) return jsonResponse({ data: { biz_data: {} } });
        throw new Error(`unexpected url ${url}`);
    }, async () => {
        await assert.rejects(
            () => upstream.uploadFileToDS({ buffer: Buffer.from('PNG'), filename: 'a.png', mime: 'image/png', account }),
            /no data\.biz_data\.id/
        );
    });
});

test('uploadFileToDS: a failing fetch_files poll does not lose the file id', async () => {
    uploadCache.getCache().clear();
    const account = { id: 'acct-uppoll', headers: {}, config: { wasmUrl: 'https://cdn.test/pow-upload-poll.wasm' } };
    await withFetch(async (url) => {
        if (url.endsWith('/chat/create_pow_challenge')) return jsonResponse(powChallenge());
        if (url === 'https://cdn.test/pow-upload-poll.wasm') return wasmResponse();
        if (url.endsWith('/file/upload_file')) return jsonResponse({ data: { biz_data: { id: 'file-9' } } });
        if (url.includes('/file/fetch_files')) {
            return jsonResponse({ data: { biz_data: { files: [{ id: 'file-9', status: 'FAILED' }] } } });
        }
        throw new Error(`unexpected url ${url}`);
    }, async () => {
        const res = await upstream.uploadFileToDS({ buffer: Buffer.from('PNG'), filename: 'a.png', mime: 'image/png', account, agentTag: '[t]' });
        assert.equal(res.id, 'file-9');
        assert.equal(res.file, undefined, 'polling failure must be swallowed');
    });
});

// --- waitForFileReady -------------------------------------------------------

test('waitForFileReady: aborts when shouldAbort() returns true', async () => {
    await assert.rejects(
        () => upstream.waitForFileReady('f1', { headers: {} }, '', { shouldAbort: () => true }),
        /aborted while waiting/
    );
});

test('waitForFileReady: retries after a transient poll error, then succeeds', async () => {
    let n = 0;
    await withFetch(async () => {
        n++;
        if (n === 1) throw new Error('network blip');
        return jsonResponse({ data: { biz_data: { files: [{ id: 'f1', status: 'SUCCESS' }] } } });
    }, async () => {
        const file = await upstream.waitForFileReady('f1', { headers: {} }, '');
        assert.equal(file.status, 'SUCCESS');
    });
});

// --- fetchFilesFromDS -------------------------------------------------------

test('fetchFilesFromDS: a 401 marks the account and throws', async () => {
    const account = { id: 'acct-ff', headers: {}, failures: 0, cooldownUntil: 0 };
    await withFetch(async () => jsonResponse('nope', { status: 401, headers: { 'retry-after': '1' } }), async () => {
        await assert.rejects(() => upstream.fetchFilesFromDS(['f1'], account), /fetch_files HTTP 401/);
    });
    assert.equal(account.failures, 1);
});

test('fetchFilesFromDS: an empty id list short-circuits to []', async () => {
    assert.deepEqual(await upstream.fetchFilesFromDS([], { headers: {} }), []);
});

test('waitForFileReady: logs and retries while the file is not visible yet', async () => {
    let n = 0;
    await withFetch(async () => {
        n++;
        // First poll: the file list is empty (file not visible yet).
        if (n === 1) return jsonResponse({ data: { biz_data: { files: [] } } });
        return jsonResponse({ data: { biz_data: { files: [{ id: 'f1', status: 'SUCCESS' }] } } });
    }, async () => {
        const file = await upstream.waitForFileReady('f1', { headers: {} }, '[t]');
        assert.equal(file.status, 'SUCCESS');
    });
});
