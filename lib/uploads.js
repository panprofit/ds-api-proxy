'use strict';
// Attachment helpers: MIME guessing, data-URI decoding, filename derivation
// and parsing of DS upload/fetch responses. Pure functions, no network.

function guessMimeFromName(name) {
    const ext = String(name || '').toLowerCase().split('.').pop();
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'bmp': return 'image/bmp';
        case 'pdf': return 'application/pdf';
        case 'txt': return 'text/plain';
        default: return 'application/octet-stream';
    }
}

function extractUploadedFileId(json) {
    return json?.data?.biz_data?.id || null;
}

// Read the file metadata list returned by GET /file/fetch_files.
// Shape: { data: { biz_data: { files: [{ id, status, file_name, ... }] } } }
function extractFetchedFiles(json) {
    const files = json?.data?.biz_data?.files;
    return Array.isArray(files) ? files : [];
}

function decodeDataUri(url) {
    const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(String(url || ''));
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const data = m[3] || '';
    const buffer = m[2]
        ? Buffer.from(data, 'base64')
        : Buffer.from(decodeURIComponent(data), 'utf8');
    return { buffer, mime };
}

function filenameForSource(url, mime, pathMod = require('path')) {
    try {
        const parsed = new URL(url);
        const base = pathMod.basename(parsed.pathname || '');
        if (base && base !== '/') return base;
    } catch (e) { /* data: URI or relative */ }
    const ext = (mime || '').split('/')[1] || 'bin';
    return `upload-${Date.now()}.${ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`;
}

module.exports = {
    guessMimeFromName,
    extractUploadedFileId,
    extractFetchedFiles,
    decodeDataUri,
    filenameForSource,
};
