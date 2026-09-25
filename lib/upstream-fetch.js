'use strict';
// SSRF guard and remote-file download. The security-sensitive URL validation
// (scheme + DNS + per-address checks, re-run on every redirect hop) and the
// size-capped body reader live in one focused, separately testable module.
// upstream.js re-exports these for existing callers/tests.

const config = require('./config');
const { guessMimeFromName } = require('./uploads');

// --- SSRF guard -------------------------------------------------------------
//
// `assertPublicUrl` rejects non-http(s) schemes and any host that names or
// resolves to a private / loopback / link-local / reserved address. IPv4 and
// IPv6 literals are checked syntactically; hostnames are resolved via DNS and
// every returned address is validated to defeat DNS-rebinding.

const dns = require('dns');
const net = require('net');

// IPv4 ranges that must never be fetched (RFC1918 + loopback + link-local +
// CGNAT + benchmarking + reserved/broadcast).
const BLOCKED_V4 = [
    /^0\./,
    /^10\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^127\./,
    /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.0\.0\./,
    /^192\.0\.2\./,
    /^192\.88\.99\./,
    /^192\.168\./,
    /^198\.(1[89]|2\d|3[01])\./,
    /^198\.51\.100\./,
    /^203\.0\.113\./,
    /^22[4-9]\./,
    /^2[3-5]\d\./,
];

function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Expand an IPv6 literal (including `::` compression and embedded IPv4) to
// its 8 hextet groups. Returns null when the input is not a valid IPv6 literal.
function parseIPv6(ip) {
    let addr = ip;
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);
    if (addr.includes('.')) {
        const lastColon = addr.lastIndexOf(':');
        const v4 = ipv4ToInt(addr.slice(lastColon + 1));
        if (v4 == null) return null;
        addr = addr.slice(0, lastColon + 1) + [(v4 >>> 16) & 0xffff, v4 & 0xffff].map(n => n.toString(16)).join(':');
    }
    const halves = addr.split('::');
    if (halves.length > 2) return null;
    const parseGroups = (s) => (s ? s.split(':').filter(x => x !== '') : []);
    const head = parseGroups(halves[0]);
    const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (halves.length === 1) {
        if (head.length !== 8) return null;
        return head.map(h => parseInt(h, 16));
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    return [...head, ...Array(missing).fill('0'), ...tail].map(h => parseInt(h, 16));
}

function isBlockedIPv6(ip) {
    const g = parseIPv6(ip);
    if (!g) return false;
    // ::1 loopback, :: unspecified
    if (g.every(x => x === 0)) return true;
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;
    // fe80::/10 link-local
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    // fc00::/7 unique-local
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    // ff00::/8 multicast
    if ((g[0] & 0xff00) === 0xff00) return true;
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded IPv4
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
        const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
        return isBlockedIPv4(v4);
    }
    return false;
}

function isBlockedIPv4(ip) {
    if (ipv4ToInt(ip) == null) return false;
    return BLOCKED_V4.some(re => re.test(ip));
}

function isBlockedAddress(address) {
    const kind = net.isIP(address);
    if (kind === 4) return isBlockedIPv4(address);
    if (kind === 6) return isBlockedIPv6(address);
    return true; // not a valid IP — treat as unsafe
}

function assertPublicUrlSync(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { throw new Error('invalid url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported scheme');
    let host = u.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked host');
    if (net.isIP(host) && isBlockedAddress(host)) throw new Error('blocked host');
    return u;
}

// Synchronous syntax-only check. Kept as `assertPublicUrl` for callers/tests
// that only need to reject literal private addresses.
function assertPublicUrl(rawUrl) {
    return assertPublicUrlSync(rawUrl);
}

// Full async guard: syntax check + DNS resolution + per-address validation.
// Every resolved address must be public, which blocks DNS-rebinding to an
// internal IP (even if the attacker's DNS later changes the answer, the
// check and the fetch happen back-to-back in fetchRemoteFile).
async function assertPublicUrlResolved(rawUrl, { lookup = dns.promises.lookup } = {}) {
    const u = assertPublicUrlSync(rawUrl);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (net.isIP(host)) return u; // literal already validated synchronously
    let records;
    try {
        records = await lookup(host, { all: true, verbatim: true });
    } catch (e) {
        throw new Error(`could not resolve host: ${host}`);
    }
    const addresses = (records || []).map(r => r.address).filter(Boolean);
    if (addresses.length === 0) throw new Error(`could not resolve host: ${host}`);
    for (const address of addresses) {
        if (isBlockedAddress(address)) throw new Error('blocked host');
    }
    return u;
}

const MAX_REDIRECTS = 5;

// Read a fetch Response body into a Buffer, aborting if it exceeds `maxBytes`.
// Checks Content-Length first (cheap reject) and also enforces the cap while
// streaming, so a chunked response without Content-Length cannot exhaust memory.
async function readBodyWithLimit(resp, maxBytes, url) {
    const declared = Number(resp.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`could not fetch ${url}: file is ${declared} bytes, exceeds ${maxBytes}`);
    }
    if (!resp.body) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`could not fetch ${url}: exceeds ${maxBytes} bytes`);
        return buffer;
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of resp.body) {
        received += chunk.length;
        if (received > maxBytes) {
            try { await resp.body.cancel(); } catch (_) { /* already closing */ }
            throw new Error(`could not fetch ${url}: exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

// Download a remote http(s) image so we can re-upload it as multipart.
// Redirects are followed manually (up to MAX_REDIRECTS hops) with the SSRF
// check re-run on every hop, and the body is size-capped so a hostile or
// misconfigured URL cannot exhaust memory before the upload-time check.
async function fetchRemoteFile(url, maxBytes = config.get().maxUploadBytes) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrlResolved(current);
        const resp = await fetch(current, { signal: AbortSignal.timeout(config.get().fetchTimeoutMs), redirect: 'manual' });
        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get('location');
            if (!location) throw new Error(`could not fetch ${url}: HTTP ${resp.status}`);
            if (hop === MAX_REDIRECTS) throw new Error(`could not fetch ${url}: too many redirects`);
            current = new URL(location, current).toString();
            continue;
        }
        if (!resp.ok) throw new Error(`could not fetch ${url}: HTTP ${resp.status}`);
        const mime = (resp.headers.get('content-type') || '').split(';')[0].trim() || guessMimeFromName(current);
        const buffer = await readBodyWithLimit(resp, maxBytes, url);
        return { buffer, mime };
    }
    throw new Error(`could not fetch ${url}: too many redirects`);
}

module.exports = {
    assertPublicUrl,
    assertPublicUrlSync,
    assertPublicUrlResolved,
    isBlockedAddress,
    fetchRemoteFile,
    readBodyWithLimit,
    MAX_REDIRECTS,
};
