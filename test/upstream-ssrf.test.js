'use strict';
// Tests for the SSRF guard and the remote-fetch / wasm-loader paths in
// lib/upstream.js. `fetch` is stubbed; `dns.promises.lookup` is stubbed for the
// paths that resolve hostnames internally (fetchRemoteFile).

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');

const accounts = require('../lib/accounts');
accounts.setRemoteHost('ds.test');
const upstream = require('../lib/upstream');

const realFetch = globalThis.fetch;

async function withFetch(impl, fn) {
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

async function withLookup(impl, fn) {
    const real = dns.promises.lookup;
    dns.promises.lookup = async (host) => impl(host);
    try { return await fn(); } finally { dns.promises.lookup = real; }
}

function resp({ status = 200, headers = {}, body = '', bodyChunks = null } = {}) {
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (headerMap.has(k.toLowerCase()) ? headerMap.get(k.toLowerCase()) : null) },
        arrayBuffer: async () => Buffer.from(body),
        body: bodyChunks
            ? (function* () { for (const c of bodyChunks) yield Buffer.from(c); })()
            : null,
    };
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

// --- isBlockedAddress -------------------------------------------------------

test('isBlockedAddress: blocks loopback/private/reserved IPv4', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '198.18.0.1',
        '224.0.0.1', '255.255.255.255']) {
        assert.equal(upstream.isBlockedAddress(ip), true, `${ip} should be blocked`);
    }
});

test('isBlockedAddress: allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
        assert.equal(upstream.isBlockedAddress(ip), false, `${ip} should be allowed`);
    }
});

test('isBlockedAddress: blocks loopback/ULA/link-local/multicast IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1']) {
        assert.equal(upstream.isBlockedAddress(ip), true, `${ip} should be blocked`);
    }
});

test('isBlockedAddress: allows public IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
        assert.equal(upstream.isBlockedAddress(ip), false, `${ip} should be allowed`);
    }
});

test('isBlockedAddress: IPv4-mapped IPv6 is classified by its embedded IPv4', () => {
    assert.equal(upstream.isBlockedAddress('::ffff:127.0.0.1'), true);
    assert.equal(upstream.isBlockedAddress('::ffff:10.0.0.1'), true);
    assert.equal(upstream.isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('isBlockedAddress: a non-IP string is treated as unsafe', () => {
    assert.equal(upstream.isBlockedAddress('not-an-ip'), true);
    assert.equal(upstream.isBlockedAddress(''), true);
});

// --- assertPublicUrl --------------------------------------------------------

test('assertPublicUrl: rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://x']) {
        assert.throws(() => upstream.assertPublicUrl(u), /unsupported scheme|invalid url/);
    }
});

test('assertPublicUrl: rejects private/loopback literals', () => {
    assert.throws(() => upstream.assertPublicUrl('http://127.0.0.1/x'), /blocked/);
    assert.throws(() => upstream.assertPublicUrl('http://10.0.0.1/x'), /blocked/);
    assert.throws(() => upstream.assertPublicUrl('http://[::1]/x'), /blocked/);
});

test('assertPublicUrl: allows a public literal and returns a URL', () => {
    const u = upstream.assertPublicUrl('https://8.8.8.8/x');
    assert.ok(u instanceof URL);
    assert.equal(u.hostname, '8.8.8.8');
});

test('assertPublicUrl: a public hostname passes the synchronous syntax check', () => {
    const u = upstream.assertPublicUrl('https://example.com/x');
    assert.equal(u.hostname, 'example.com');
});

// --- assertPublicUrlResolved ------------------------------------------------

test('assertPublicUrlResolved: resolves a hostname and allows a public address', async () => {
    const lookup = async () => PUBLIC;
    const u = await upstream.assertPublicUrlResolved('https://example.com/x', { lookup });
    assert.equal(u.hostname, 'example.com');
});

test('assertPublicUrlResolved: blocks a hostname resolving to a private IP', async () => {
    const lookup = async () => [{ address: '10.0.0.1', family: 4 }];
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://evil.example/x', { lookup }),
        /blocked/
    );
});

test('assertPublicUrlResolved: blocks when ANY resolved address is private', async () => {
    const lookup = async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
    ];
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://mixed.example/x', { lookup }),
        /blocked/
    );
});

test('assertPublicUrlResolved: rejects when DNS returns nothing', async () => {
    const lookup = async () => [];
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://empty.example/x', { lookup }),
        /could not resolve/
    );
});

test('assertPublicUrlResolved: a DNS failure is reported as unresolved', async () => {
    const lookup = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(
        () => upstream.assertPublicUrlResolved('https://nx.example/x', { lookup }),
        /could not resolve/
    );
});

test('assertPublicUrlResolved: an IP literal skips DNS and is validated directly', async () => {
    let called = false;
    const lookup = async () => { called = true; return []; };
    const u = await upstream.assertPublicUrlResolved('https://93.184.216.34/x', { lookup });
    assert.equal(u.hostname, '93.184.216.34');
    assert.equal(called, false, 'literal IP should not trigger a DNS lookup');
});

// --- fetchRemoteFile --------------------------------------------------------

test('fetchRemoteFile: fetches a public URL and returns buffer + mime', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async () => resp({
            status: 200, headers: { 'content-type': 'image/png' }, body: 'PNGDATA',
        }), async () => {
            const out = await upstream.fetchRemoteFile('https://example.com/a.png', 1024);
            assert.equal(out.buffer.toString(), 'PNGDATA');
            assert.equal(out.mime, 'image/png');
        });
    });
});

test('fetchRemoteFile: rejects a private literal before any fetch', async () => {
    let fetched = 0;
    await withFetch(async () => { fetched++; return resp({}); }, async () => {
        await assert.rejects(() => upstream.fetchRemoteFile('http://127.0.0.1/x'), /blocked/);
    });
    assert.equal(fetched, 0, 'no fetch for a blocked literal');
});

test('fetchRemoteFile: rejects a hostname that resolves to a private IP', async () => {
    await withLookup(() => [{ address: '10.1.2.3', family: 4 }], async () => {
        let fetched = 0;
        await withFetch(async () => { fetched++; return resp({}); }, async () => {
            await assert.rejects(() => upstream.fetchRemoteFile('https://evil.example/x', 1024), /blocked/);
        });
        assert.equal(fetched, 0, 'no fetch when DNS points private');
    });
});

test('fetchRemoteFile: follows a redirect and re-validates the new host', async () => {
    const seen = [];
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async (url) => {
            seen.push(url);
            if (url === 'https://example.com/a') {
                return resp({ status: 302, headers: { location: 'https://cdn.example/b.png' } });
            }
            return resp({ status: 200, headers: { 'content-type': 'image/jpeg' }, body: 'JPG' });
        }, async () => {
            const out = await upstream.fetchRemoteFile('https://example.com/a', 1024);
            assert.equal(out.buffer.toString(), 'JPG');
            assert.equal(out.mime, 'image/jpeg');
            assert.deepEqual(seen, ['https://example.com/a', 'https://cdn.example/b.png']);
        });
    });
});

test('fetchRemoteFile: blocks a redirect pointing at a private literal', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async (url) => {
            if (url === 'https://example.com/a') {
                return resp({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
            }
            return resp({ status: 200, body: 'SECRET' });
        }, async () => {
            await assert.rejects(
                () => upstream.fetchRemoteFile('https://example.com/a', 1024),
                /blocked/
            );
        });
    });
});

test('fetchRemoteFile: gives up after too many redirects', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async () => resp({ status: 302, headers: { location: 'https://example.com/next' } }), async () => {
            await assert.rejects(
                () => upstream.fetchRemoteFile('https://example.com/a', 1024),
                /too many redirects/
            );
        });
    });
});

test('fetchRemoteFile: surfaces a non-2xx final status', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async () => resp({ status: 404 }), async () => {
            await assert.rejects(
                () => upstream.fetchRemoteFile('https://example.com/missing', 1024),
                /HTTP 404/
            );
        });
    });
});

test('fetchRemoteFile: rejects an oversized Content-Length without reading the body', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async () => resp({ status: 200, headers: { 'content-length': '999999' }, body: 'x' }), async () => {
            await assert.rejects(
                () => upstream.fetchRemoteFile('https://example.com/big', 1000),
                /exceeds/
            );
        });
    });
});

test('fetchRemoteFile: enforces the cap while streaming a chunked body', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async () => resp({
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            bodyChunks: [Buffer.alloc(600), Buffer.alloc(600)],
        }), async () => {
            await assert.rejects(
                () => upstream.fetchRemoteFile('https://example.com/stream', 1000),
                /exceeds/
            );
        });
    });
});

test('fetchRemoteFile: infers mime from the URL when Content-Type is absent', async () => {
    await withLookup(() => PUBLIC, async () => {
        await withFetch(async () => resp({ status: 200, headers: {}, body: 'x' }), async () => {
            const out = await upstream.fetchRemoteFile('https://example.com/pic.png', 1024);
            assert.equal(out.mime, 'image/png');
        });
    });
});

// --- loadModule -------------------------------------------------------------

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

test('loadModule: fetches and compiles a valid wasm module', async () => {
    await withFetch(async () => resp({ status: 200, body: WASM_MAGIC }), async () => {
        const mod = await upstream.loadModule('https://example.com/m1.wasm');
        assert.ok(mod instanceof WebAssembly.Module);
    });
});

test('loadModule: throws without a wasmUrl', async () => {
    await assert.rejects(() => upstream.loadModule(''), /wasmUrl/);
});

test('loadModule: throws when the wasm fetch is not OK', async () => {
    await withFetch(async () => resp({ status: 500, body: '' }), async () => {
        await assert.rejects(() => upstream.loadModule('https://example.com/m2.wasm'), /HTTP 500/);
    });
});

test('loadModule: caches per URL and returns the same module', async () => {
    let fetches = 0;
    await withFetch(async () => { fetches++; return resp({ status: 200, body: WASM_MAGIC }); }, async () => {
        const a = await upstream.loadModule('https://example.com/cached.wasm');
        const b = await upstream.loadModule('https://example.com/cached.wasm');
        assert.equal(a, b, 'second load returns the cached module');
        assert.equal(fetches, 1, 'wasm fetched only once');
    });
});

test('loadModule: does not cache a failed compile', async () => {
    let fetches = 0;
    await withFetch(async () => { fetches++; return resp({ status: 200, body: Buffer.from('not wasm') }); }, async () => {
        await assert.rejects(() => upstream.loadModule('https://example.com/bad.wasm'));
        await assert.rejects(() => upstream.loadModule('https://example.com/bad.wasm'));
        assert.equal(fetches, 2, 'a failed compile must not be cached');
    });
});
