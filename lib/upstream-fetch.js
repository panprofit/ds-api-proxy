'use strict';

const config = require('./config');
const { guessMimeFromName } = require('./uploads');

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

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

    if (g.every(x => x === 0)) return true;
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;

    if ((g[0] & 0xffc0) === 0xfe80) return true;

    if ((g[0] & 0xfe00) === 0xfc00) return true;

    if ((g[0] & 0xff00) === 0xff00) return true;

    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
        return isBlockedIPv4(embeddedIPv4(g));
    }

    if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
        return isBlockedIPv4(embeddedIPv4(g));
    }

    if (g[0] === 0x2002) {
        return isBlockedIPv4(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`);
    }
    return false;
}

function embeddedIPv4(g) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
}

function isBlockedIPv4(ip) {
    if (ipv4ToInt(ip) == null) return false;
    return BLOCKED_V4.some(re => re.test(ip));
}

function isBlockedAddress(address) {
    const kind = net.isIP(address);
    if (kind === 4) return isBlockedIPv4(address);
    if (kind === 6) return isBlockedIPv6(address);
    return true;
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

function assertPublicUrl(rawUrl) {
    return assertPublicUrlSync(rawUrl);
}

function fetchError(url, detail) {
    return new Error(`could not fetch ${url}: ${detail}`);
}

function hostError(host) {
    return new Error(`could not resolve host: ${host}`);
}

async function resolvePublicTarget(rawUrl, { lookup = dns.promises.lookup } = {}) {
    const u = assertPublicUrlSync(rawUrl);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (net.isIP(host)) return { url: u, address: host };
    let records;
    try {
        records = await lookup(host, { all: true, verbatim: true });
    } catch (e) {
        throw hostError(host);
    }
    const addresses = (records || []).map(r => r.address).filter(Boolean);
    if (addresses.length === 0) throw hostError(host);
    for (const address of addresses) {
        if (isBlockedAddress(address)) throw new Error('blocked host');
    }
    return { url: u, address: addresses[0] };
}

async function assertPublicUrlResolved(rawUrl, options) {
    return (await resolvePublicTarget(rawUrl, options)).url;
}

function pinnedRequest(rawUrl, { address, timeoutMs }) {
    const u = new URL(rawUrl);
    const transport = u.protocol === 'https:' ? https : http;
    const hostIsIp = net.isIP(u.hostname) !== 0;
    const options = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { host: u.host, 'user-agent': 'ds-api-proxy' },
        signal: AbortSignal.timeout(timeoutMs),
    };
    if (!hostIsIp) {
        options.servername = u.hostname;
        options.lookup = (hostname, opts, cb) => cb(null, address, net.isIP(address));
    }
    return new Promise((resolve, reject) => {
        const req = transport.request(options, (res) => {
            resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
                body: res,
            });
        });
        req.on('error', reject);
        req.end();
    });
}

const MAX_REDIRECTS = 5;

async function readBodyWithLimit(resp, maxBytes, url) {
    const declared = Number(resp.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw fetchError(url, `file is ${declared} bytes, exceeds ${maxBytes}`);
    }
    if (!resp.body) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > maxBytes) throw fetchError(url, `exceeds ${maxBytes} bytes`);
        return buffer;
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of resp.body) {
        received += chunk.length;
        if (received > maxBytes) {
            try {
                if (typeof resp.body.cancel === 'function') await resp.body.cancel();
                else if (typeof resp.body.destroy === 'function') resp.body.destroy();
            } catch (_) {  }
            throw fetchError(url, `exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function fetchRemoteFile(url, maxBytes = config.get().maxUploadBytes, { request = pinnedRequest } = {}) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const { address } = await resolvePublicTarget(current);
        const resp = await request(current, { address, timeoutMs: config.get().fetchTimeoutMs });
        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get('location');
            if (!location) throw fetchError(url, `HTTP ${resp.status}`);
            if (hop === MAX_REDIRECTS) throw fetchError(url, 'too many redirects');
            if (resp.body && typeof resp.body.destroy === 'function') resp.body.destroy();
            current = new URL(location, current).toString();
            continue;
        }
        if (!resp.ok) throw fetchError(url, `HTTP ${resp.status}`);
        const mime = (resp.headers.get('content-type') || '').split(';')[0].trim() || guessMimeFromName(current);
        const buffer = await readBodyWithLimit(resp, maxBytes, url);
        return { buffer, mime };
    }
    throw fetchError(url, 'too many redirects');
}

module.exports = {
    assertPublicUrl,
    assertPublicUrlSync,
    assertPublicUrlResolved,
    resolvePublicTarget,
    pinnedRequest,
    isBlockedAddress,
    fetchRemoteFile,
    readBodyWithLimit,
};
