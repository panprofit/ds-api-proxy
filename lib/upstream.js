'use strict';

const {
    guessMimeFromName,
    extractUploadedFileId,
    extractFetchedFiles,
    decodeDataUri,
    filenameForSource,
} = require('./uploads');
const { buildPowHeader } = require('./pow');
const accounts = require('./accounts');
const uploadCache = require('./upload-cache');
const { debugLog } = require('./debug');
const { createTypedError, typeForStatus, truncateForLog } = require('./http');
const crypto = require('crypto');

const { loadModule, solvePOW } = require('./upstream-pow');
const {
    assertPublicUrl, assertPublicUrlSync, assertPublicUrlResolved,
    isBlockedAddress, fetchRemoteFile,
} = require('./upstream-fetch');

const CHAT_MODEL_TYPE = 'default';
const CHAT_SEARCH_ENABLED = true;
const CHAT_THINKING_ENABLED = false;

function buildCompletionPayload({ sessionId, parentMessageId, prompt, fileIds = [], thinkingEnabled = CHAT_THINKING_ENABLED, searchEnabled = CHAT_SEARCH_ENABLED }) {
    return {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: CHAT_MODEL_TYPE,
        prompt,
        ref_file_ids: fileIds,
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        action: null,
        preempt: false,
    };
}

const config = require('./config');

const DS_FETCH_TIMEOUT_MS = config.get().fetchTimeoutMs;

const FILE_SUCCESS_STATUSES = new Set(['SUCCESS']);
const FILE_FAILURE_STATUSES = new Set(['FAILED', 'ERROR', 'AUDIT_FAILED', 'REJECTED']);

const UPLOAD_FIELD_NAME = 'file';
const MAX_UPLOAD_BYTES = config.get().maxUploadBytes;

/**
 * @param {string} url
 * @param {{ signal?: AbortSignal, timeoutMs?: number, [key: string]: any }} [options]
 * @returns {Promise<Response>}
 */
function dsFetch(url, options = {}) {

    const { timeoutMs = config.get().fetchTimeoutMs, signal = null, ...fetchOptions } = options;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    const signals = [signal, timeoutSignal].filter(Boolean);
    return fetch(`https://${config.get().remoteHost}/api/v0${url}`, {
        ...fetchOptions,

        ...(signals.length > 0
            ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }
            : {}),
    });
}

async function readDSJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            accounts.markAccountFailure(account, resp.status, label);

            throw createTypedError('upstream_protocol_error', 502, `DS returned non-JSON ${label} response (HTTP ${resp.status}). First chars: ${truncateForLog(text, 120, '')}`);
        }
    }
    if (!resp.ok) accounts.markAccountFailure(account, resp.status, label);
    return { json, text };
}

function completionTimeoutMs() { return config.get().completionTimeoutMs; }

async function dsChatCompletionWithPow({ sessionId, parentMessageId, prompt, powHeader, dsHeaders, fileIds = [], thinkingEnabled, searchEnabled, signal = null }) {
    return dsFetch('/chat/completion', {
        method: 'POST',
        headers: { ...dsHeaders, 'X-DS-PoW-Response': powHeader },
        body: JSON.stringify(buildCompletionPayload({ sessionId, parentMessageId, prompt, fileIds, thinkingEnabled, searchEnabled })),

        timeoutMs: completionTimeoutMs(),
        signal,
    });
}

const lastTokenRefreshAt = new WeakMap();

async function refreshAccountToken(account, now = Date.now()) {
    const intervalMs = config.get().tokenRefreshIntervalMs;
    if (!account || !(intervalMs > 0)) return false;
    const last = lastTokenRefreshAt.get(account) || 0;
    if (now - last < intervalMs) return false;

    lastTokenRefreshAt.set(account, now);
    try {
        const resp = await dsFetch('/users/current', { headers: account.headers });
        if (!resp.ok) {
            debugLog(console.log, `token refresh: users/current returned HTTP ${resp.status} for account ${account.id}`);
            return false;
        }
        const json = await resp.json();
        const token = json?.data?.biz_data?.token;
        if (!accounts.setAccountToken(account, token)) return false;

        accounts.persistAccountToken(account);
        debugLog(console.log, `token refresh: updated bearer token for account ${account.id}`);
        return true;
    } catch (e) {
        debugLog(console.log, `token refresh failed for account ${account.id}: ${e && e.message}`);
        return false;
    }
}

async function solvePowForPath(account, dsHeaders, targetPath, label = targetPath) {
    const cr = await dsFetch('/chat/create_pow_challenge', {
        method: 'POST', headers: dsHeaders,
        body: JSON.stringify({ target_path: targetPath }),
    });
    const chalText = await cr.text();
    if (!cr.ok) {
        accounts.markAccountFailure(account, cr.status, `pow challenge (${label})`);

        throw createTypedError(typeForStatus(cr.status), cr.status, `DS auth/network error while creating PoW challenge for ${label}: HTTP ${cr.status}.`);
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) { throw createTypedError('upstream_protocol_error', 502, `DS returned non-JSON PoW response (${label}). First chars: ${truncateForLog(chalText, 120, '')}`); }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {

        throw createTypedError('auth_expired', 401, `DS PoW response has no data.biz_data.challenge for ${label}. Auth may be expired, captcha may be required, or DS changed Web API.`);
    }
    const wasmUrl = account?.config?.wasmUrl;
    if (!wasmUrl) {

        throw createTypedError('configuration_error', 500, `PoW WASM URL is missing on account ${account?.id || '(unknown)'} (re-run \`npm run auth\`)`);
    }
    const answer = await solvePOW(challenge, wasmUrl);
    return buildPowHeader(challenge, answer, targetPath);
}

async function deleteRemoteSession(account, dsHeaders, sessionId, label = 'session delete') {
    if (!sessionId) return false;
    try {
        const dr = await dsFetch('/chat_session/delete', {
            method: 'POST', headers: dsHeaders, body: JSON.stringify({ chat_session_ids: [sessionId] }),
        });
        const text = await dr.text();
        if (!dr.ok) {
            if ([401, 403, 429].includes(dr.status)) {
                accounts.markAccountFailure(account, dr.status, label, dr.headers.get('retry-after'));
            }
            console.log(`[DS-API] ${label}: HTTP ${dr.status}: ${truncateForLog(text, 200, '')}`);
            return false;
        }
        debugLog(console.log, `[DS-API] ${label}: remote session ${sessionId} deleted`);
        return true;
    } catch (e) {
        debugLog(console.log, `[DS-API] ${label} failed: ${e.message}`);
        return false;
    }
}

async function createRemoteSession(account, dsHeaders, label) {

    const sr = await dsFetch('/chat_session/create', {
        method: 'POST', headers: dsHeaders, body: '{}',
    });
    const { json } = await readDSJsonResponse(sr, label, account);
    const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id;
    if (!sr.ok || !id) {

        const authFailure = sr.status === 401 || sr.status === 403 || (sr.ok && !id);
        const type = authFailure ? 'auth_expired' : typeForStatus(sr.status);
        const status = authFailure ? 401 : sr.status;
        throw createTypedError(type, status, `Could not create DS chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked.`);
    }
    return id;
}

async function buildUploadBody(buffer, filename, mime) {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mime });
    form.append(UPLOAD_FIELD_NAME, blob, filename);
    return form;
}

function uploadCacheKey({ account, buffer, mime }) {
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);

    return `${account.id}\u0000${fileHash}\u0000${mime}`;
}

async function uploadFileToDS({ buffer, filename, mime, account, agentTag = '', shouldAbort = null }) {
    const maxUploadBytes = config.get().maxUploadBytes;
    if (!buffer || buffer.length === 0) throw new Error(`upload: empty buffer for ${filename}`);
    if (buffer.length > maxUploadBytes) {
        throw new Error(`upload: ${filename} is ${buffer.length} bytes, exceeds ${maxUploadBytes}`);
    }
    const effectiveMime = mime || guessMimeFromName(filename);
    const cacheKey = uploadCacheKey({ account, buffer, mime: effectiveMime });
    if (uploadCache.has(cacheKey)) return uploadCache.get(cacheKey);

    const headers = { ...account.headers };
    delete headers['Content-Type'];
    delete headers['content-type'];

    const powHeader = await solvePowForPath(account, account.headers, '/api/v0/file/upload_file', 'file upload');
    headers['X-DS-PoW-Response'] = powHeader;

    const form = await buildUploadBody(buffer, filename, effectiveMime);
    const resp = await dsFetch('/file/upload_file', { method: 'POST', headers, body: form });
    const text = await resp.text();
    if (!resp.ok) {
        if ([401, 403, 429].includes(resp.status)) {
            accounts.markAccountFailure(account, resp.status, 'file upload', resp.headers.get('retry-after'));
        }
        throw createTypedError(typeForStatus(resp.status), resp.status, `upload HTTP ${resp.status}: ${truncateForLog(text, 200, '')}`);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { debugLog(console.log, `[DS-API] upload response is not JSON: ${e.message}`); }
    const id = extractUploadedFileId(json);
    if (!id) {
        throw createTypedError('upstream_protocol_error', 502, `upload response has no data.biz_data.id: ${truncateForLog(text, 200, '')}`);
    }
    const result = { id, filename, mime: effectiveMime };
    if (agentTag) console.log(`${agentTag} Uploaded ${filename} (${buffer.length}B) -> file_id=${id}`);

    try {
        const fileInfo = await waitForFileReady(id, account, agentTag, { shouldAbort });
        if (fileInfo) result.file = fileInfo;
    } catch (e) {
        if (agentTag) debugLog(console.log, `${agentTag} fetch_files failed for ${id}: ${e.message}`);
    }
    uploadCache.set(cacheKey, { ...result, cachedAt: Date.now() });
    return result;
}

async function waitForFileReady(fileId, account, agentTag = '', { shouldAbort = null } = {}) {
    const pollIntervalMs = config.get().filePollIntervalMs;
    const deadline = Date.now() + config.get().filePollTimeoutMs;
    let lastStatus = null;
    let lastError = null;
    while (Date.now() < deadline) {
        if (shouldAbort && shouldAbort()) {
            throw new Error(`aborted while waiting for file ${fileId} to become SUCCESS`);
        }
        let files;
        try {
            files = await fetchFilesFromDS([fileId], account);
        } catch (e) {
            lastError = e.message;
            if (agentTag) debugLog(console.log, `${agentTag} File ${fileId} poll error (${e.message}); retrying`);
            await new Promise(r => setTimeout(r, pollIntervalMs));
            continue;
        }
        const file = files.find(f => f && f.id === fileId) || files[0] || null;
        if (!file) {
            if (agentTag) console.log(`${agentTag} File ${fileId} not visible yet; retrying`);
        } else {
            lastStatus = file.status;
            if (FILE_SUCCESS_STATUSES.has(lastStatus)) {
                if (agentTag) console.log(`${agentTag} File ${fileId} ready (status=${lastStatus}, name=${file.file_name})`);
                return file;
            }
            if (FILE_FAILURE_STATUSES.has(lastStatus)) {
                throw new Error(`file ${fileId} failed with status=${lastStatus}${file.error_code ? ` (${file.error_code})` : ''}`);
            }
            if (agentTag) console.log(`${agentTag} File ${fileId} status=${lastStatus}; waiting for SUCCESS`);
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`timed out after ${config.get().filePollTimeoutMs}ms waiting for file ${fileId} to become SUCCESS (last status=${lastStatus}${lastError ? `, last error=${lastError}` : ''})`);
}

async function fetchFilesFromDS(fileIds, account) {
    const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).filter(Boolean);
    if (ids.length === 0) return [];
    const query = `?file_ids=${encodeURIComponent(ids.join(','))}`;
    const resp = await dsFetch(`/file/fetch_files${query}`, {
        method: 'GET',
        headers: account.headers,
    });
    const text = await resp.text();
    if (!resp.ok) {
        if ([401, 403, 429].includes(resp.status)) {
            accounts.markAccountFailure(account, resp.status, 'file fetch_files', resp.headers.get('retry-after'));
        }
        throw createTypedError(typeForStatus(resp.status), resp.status, `fetch_files HTTP ${resp.status}: ${truncateForLog(text, 200, '')}`);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { debugLog(console.log, `[DS-API] fetch_files response is not JSON: ${e.message}`); }
    return extractFetchedFiles(json);
}

async function resolveMessageAttachments(messages, account, agentTag = '', {
    shouldAbort = null,

    fetchFile = fetchRemoteFile,
    uploadFile = uploadFileToDS,
    decode = decodeDataUri,
    nameForSource = filenameForSource,
} = {}) {
    const fileIds = [];
    const uploads = [];
    const failures = [];
    const seen = new Set();
    for (const msg of messages || []) {
        if (!msg || !Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
            if (!part || typeof part !== 'object' || part.type !== 'image_url') continue;
            const url = part.image_url?.url;
            if (!url) continue;
            try {
                let buffer, mime, filename;
                const dataUri = decode(url);
                if (dataUri) {
                    buffer = dataUri.buffer;
                    mime = dataUri.mime;
                    filename = nameForSource(part.image_url?.detail || '', mime);
                } else if (/^https?:\/\//i.test(url)) {
                    ({ buffer, mime } = await fetchFile(url, config.get().maxUploadBytes));
                    filename = nameForSource(url, mime);
                } else {
                    failures.push({ url, error: 'unsupported image_url scheme' });
                    continue;
                }

                const key = crypto.createHash('sha256').update(buffer).digest('hex');
                if (seen.has(key)) continue;
                seen.add(key);
                const uploaded = await uploadFile({ buffer, filename, mime, account, agentTag, shouldAbort });
                uploads.push(uploaded);
                fileIds.push(uploaded.id);
            } catch (e) {
                failures.push({ url: truncateForLog(String(url), 120, ''), error: e.message });
                if (agentTag) debugLog(console.log, `${agentTag} attachment upload failed: ${e.message}`);
            }
        }
    }
    return { fileIds, uploads, failures };
}

module.exports = {
    CHAT_MODEL_TYPE,
    CHAT_SEARCH_ENABLED,
    CHAT_THINKING_ENABLED,
    buildCompletionPayload,
    dsChatCompletionWithPow,
    completionTimeoutMs,
    DS_FETCH_TIMEOUT_MS,
    MAX_UPLOAD_BYTES,
    dsFetch,
    readDSJsonResponse,
    refreshAccountToken,
    solvePowForPath,
    deleteRemoteSession,
    createRemoteSession,
    buildUploadBody,
    uploadCacheKey,
    uploadFileToDS,
    waitForFileReady,
    fetchFilesFromDS,
    assertPublicUrl,
    assertPublicUrlSync,
    assertPublicUrlResolved,
    isBlockedAddress,
    fetchRemoteFile,
    resolveMessageAttachments,
    loadModule,
    solvePOW,
};
