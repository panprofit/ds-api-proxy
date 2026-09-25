'use strict';
// DeepSeek upstream network layer: PoW challenge solving, chat-session
// create/delete, chat completion, and attachment upload/polling.
// Request/response handling can be unit-tested without starting the HTTP
// server.
//
// Singleton module. It reads accounts via `./accounts` and the attachment
// cache via `./upload-cache`. `REMOTE_HOST` is validated by index.js; call
// `accounts.setRemoteHost()` before using the fetch helpers in tests.

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
const { createTypedError, typeForStatus } = require('./http');
const crypto = require('crypto');

const { loadModule, solvePOW } = require('./upstream-pow');
const {
    assertPublicUrl, assertPublicUrlSync, assertPublicUrlResolved,
    isBlockedAddress, fetchRemoteFile,
} = require('./upstream-fetch');

// Chat completion payload is built here so index.js and dsChatCompletion
// cannot drift apart (model_type/flags were previously duplicated inline).
const CHAT_MODEL_TYPE = 'default';
const CHAT_SEARCH_ENABLED = true;
const CHAT_THINKING_ENABLED = false;

function buildCompletionPayload({ sessionId, parentMessageId, prompt, fileIds = [], thinkingEnabled = CHAT_THINKING_ENABLED }) {
    return {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: CHAT_MODEL_TYPE,
        prompt,
        ref_file_ids: fileIds,
        thinking_enabled: thinkingEnabled,
        search_enabled: CHAT_SEARCH_ENABLED,
        action: null,
        preempt: false,
    };
}

// Config is read lazily at call time. The exported constants below are a
// load-time snapshot kept for tests/back-compat.
const config = require('./config');

const DS_FETCH_TIMEOUT_MS = config.get().fetchTimeoutMs;
// Polling of /file/fetch_files until an uploaded file reaches a terminal status.
const FILE_STATUS_POLL_INTERVAL_MS = config.get().filePollIntervalMs;
const FILE_STATUS_POLL_TIMEOUT_MS = config.get().filePollTimeoutMs;
const FILE_SUCCESS_STATUSES = new Set(['SUCCESS']);
const FILE_FAILURE_STATUSES = new Set(['FAILED', 'ERROR', 'AUDIT_FAILED', 'REJECTED']);

const UPLOAD_FIELD_NAME = 'file';
const MAX_UPLOAD_BYTES = config.get().maxUploadBytes;

function dsFetch(url, options = {}, timeoutMs = config.get().fetchTimeoutMs) {
    return fetch(`https://${accounts.getRemoteHost()}/api/v0${url}`, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

async function readDSJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            accounts.markAccountFailure(account, resp.status, label);
            // A non-JSON body is protocol drift (a WAF/captcha HTML page, an
            // error page), not a plain 500: tag it so the HTTP writer reports
            // 502 upstream_protocol_error instead of a generic server_error.
            throw createTypedError('upstream_protocol_error', 502, `DS returned non-JSON ${label} response (HTTP ${resp.status}). First chars: ${text.substring(0, 120)}`);
        }
    }
    if (!resp.ok) accounts.markAccountFailure(account, resp.status, label);
    return { json, text };
}

async function dsChatCompletion({ sessionId, parentMessageId, prompt, challenge, answer, dsHeaders, fileIds = [], thinkingEnabled }) {
    const powB64 = buildPowHeader(challenge, answer);
    return dsChatCompletionWithPow({ sessionId, parentMessageId, prompt, powHeader: powB64, dsHeaders, fileIds, thinkingEnabled });
}

// Send a chat completion with an already-solved X-DS-PoW-Response header.
// Used by recovery paths that obtain a fresh PoW via solvePowForPath().
async function dsChatCompletionWithPow({ sessionId, parentMessageId, prompt, powHeader, dsHeaders, fileIds = [], thinkingEnabled }) {
    return dsFetch('/chat/completion', {
        method: 'POST',
        headers: { ...dsHeaders, 'X-DS-PoW-Response': powHeader },
        body: JSON.stringify(buildCompletionPayload({ sessionId, parentMessageId, prompt, fileIds, thinkingEnabled })),
    });
}

// Request a fresh PoW challenge for `targetPath` and solve it. Returns the
// base64 X-DS-PoW-Response value ready to attach to the matching request.
async function solvePowForPath(account, dsHeaders, targetPath, label = targetPath) {
    const cr = await dsFetch('/chat/create_pow_challenge', {
        method: 'POST', headers: dsHeaders,
        body: JSON.stringify({ target_path: targetPath })
    });
    const chalText = await cr.text();
    if (!cr.ok) {
        accounts.markAccountFailure(account, cr.status, `pow challenge (${label})`);
        // Carry type/status so a 401/403 here rotates the account and a 429
        // surfaces as rate_limit_error, instead of a bare Error -> 500.
        throw createTypedError(typeForStatus(cr.status), cr.status, `DS auth/network error while creating PoW challenge for ${label}: HTTP ${cr.status}.`);
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) { throw createTypedError('upstream_protocol_error', 502, `DS returned non-JSON PoW response (${label}). First chars: ${chalText.substring(0, 120)}`); }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {
        // No challenge means the account's credentials are unusable, not that
        // the network blipped: tag it so the recovery loop rotates accounts.
        throw createTypedError('auth_expired', 401, `DS PoW response has no data.biz_data.challenge for ${label}. Auth may be expired, captcha may be required, or DS changed Web API.`);
    }
    const wasmUrl = account?.config?.wasmUrl;
    if (!wasmUrl) {
        // Local misconfiguration (bad auth file), not an upstream fault.
        throw createTypedError('configuration_error', 500, `PoW WASM URL is missing on account ${account?.id || '(unknown)'} (re-run \`npm run auth\`)`);
    }
    const answer = await solvePOW(challenge, wasmUrl);
    return buildPowHeader(challenge, answer, targetPath);
}

// Best-effort deletion of a single remote chat session by id. Used before a
// local session is reset so the upstream session does not leak. Failures are
// logged but never block the caller: the local reset must always proceed.
async function deleteRemoteSession(account, dsHeaders, sessionId, label = 'session delete') {
    if (!sessionId) return false;
    try {
        const dr = await dsFetch('/chat_session/delete', {
            method: 'POST', headers: dsHeaders, body: JSON.stringify({ chat_session_ids: [sessionId] })
        });
        const text = await dr.text();
        if (!dr.ok) {
            if ([401, 403, 429].includes(dr.status)) {
                accounts.markAccountFailure(account, dr.status, label, dr.headers.get('retry-after'));
            }
            console.log(`[DS-API] ${label}: HTTP ${dr.status}: ${text.substring(0, 200)}`);
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
    // Do NOT delete every remote session for the account here: with multiple
    // agents sharing an account, a single agent's session recreation would wipe
    // unrelated agents' live sessions. Rely on per-session TTL/rollover and let
    // the upstream expire stale sessions on its own.
    const sr = await dsFetch('/chat_session/create', {
        method: 'POST', headers: dsHeaders, body: '{}'
    });
    const { json } = await readDSJsonResponse(sr, label, account);
    const id = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id;
    if (!sr.ok || !id) {
        // 401/403, or an "ok" response with no session id, means the account
        // itself is unusable (expired auth / captcha) -- tag it auth_expired so
        // recovery rotates to another account instead of failing the request.
        // Any other non-OK status keeps its HTTP classification.
        const authFailure = sr.status === 401 || sr.status === 403 || (sr.ok && !id);
        const type = authFailure ? 'auth_expired' : typeForStatus(sr.status);
        const status = authFailure ? 401 : sr.status;
        throw createTypedError(type, status, `Could not create DS chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked.`);
    }
    return id;
}

// --- File upload (multipart/form-data) -------------------------------------
// DS web uploads attachments to /file/upload_file with the binary in the
// `file` form field; the returned id lives at data.biz_data.id.

// Build a FormData body for one file.
async function buildUploadBody(buffer, filename, mime) {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mime });
    form.append(UPLOAD_FIELD_NAME, blob, filename);
    return form;
}

// Build the upload-cache key for one attachment.
//   account.id  - different slots must not share entries.
//   credHash    - binds to token+cookie: a file_id belongs to the session that
//                 uploaded it, so after credentials rotate the cached id may be
//                 stale/foreign and must not be reused.
//   fileHash    - content hash, so two distinct files that happen to share a
//                 name/size/mime cannot collide, and the same file under a
//                 different name is uploaded only once.
//   mime        - kept so an explicitly differing mime still splits the key.
function uploadCacheKey({ account, buffer, mime }) {
    const credHash = crypto.createHash('sha256')
        .update(`${account.config?.token || ''}\u0000${account.config?.cookie || ''}`)
        .digest('hex').slice(0, 16);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    return `${account.id}\u0000${credHash}\u0000${fileHash}\u0000${mime}`;
}

// Upload a single file to DS and return its file id.
async function uploadFileToDS({ buffer, filename, mime, account, agentTag = '', shouldAbort = null }) {
    const maxUploadBytes = config.get().maxUploadBytes;
    if (!buffer || buffer.length === 0) throw new Error(`upload: empty buffer for ${filename}`);
    if (buffer.length > maxUploadBytes) {
        throw new Error(`upload: ${filename} is ${buffer.length} bytes, exceeds ${maxUploadBytes}`);
    }
    const effectiveMime = mime || guessMimeFromName(filename);
    const cacheKey = uploadCacheKey({ account, buffer, mime: effectiveMime });
    if (uploadCache.has(cacheKey)) return uploadCache.get(cacheKey);

    // Strip the JSON Content-Type so fetch sets the multipart boundary itself.
    const headers = { ...account.headers };
    delete headers['Content-Type'];
    delete headers['content-type'];

    // /file/upload_file is PoW-protected: solve a fresh challenge for its path.
    const powHeader = await solvePowForPath(account, account.headers, '/api/v0/file/upload_file', 'file upload');
    headers['X-DS-PoW-Response'] = powHeader;

    const form = await buildUploadBody(buffer, filename, effectiveMime);
    const resp = await dsFetch('/file/upload_file', { method: 'POST', headers, body: form });
    const text = await resp.text();
    if (!resp.ok) {
        if ([401, 403, 429].includes(resp.status)) {
            accounts.markAccountFailure(account, resp.status, 'file upload', resp.headers.get('retry-after'));
        }
        throw createTypedError(typeForStatus(resp.status), resp.status, `upload HTTP ${resp.status}: ${text.substring(0, 200)}`);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { debugLog(console.log, `[DS-API] upload response is not JSON: ${e.message}`); }
    const id = extractUploadedFileId(json);
    if (!id) {
        throw createTypedError('upstream_protocol_error', 502, `upload response has no data.biz_data.id: ${text.substring(0, 200)}`);
    }
    const result = { id, filename, mime: effectiveMime };
    if (agentTag) console.log(`${agentTag} Uploaded ${filename} (${buffer.length}B) -> file_id=${id}`);
    // After a successful upload, poll /file/fetch_files until the file reaches a
    // terminal status (SUCCESS) so callers only see fully parsed attachments.
    // Best-effort: a polling failure must not lose the file id.
    try {
        const fileInfo = await waitForFileReady(id, account, agentTag, { shouldAbort });
        if (fileInfo) result.file = fileInfo;
    } catch (e) {
        if (agentTag) debugLog(console.log, `${agentTag} fetch_files failed for ${id}: ${e.message}`);
    }
    uploadCache.set(cacheKey, { ...result, cachedAt: Date.now() });
    return result;
}

// Poll GET /file/fetch_files for a single file until its status is terminal.
// Returns the final file metadata object, or null if it never appeared.
// Throws if the file reports a failure status or the wait times out. Transient
// fetch errors (network blips, upstream 5xx) do NOT abort the poll: they are
// logged and retried until the deadline, so a brief hiccup does not lose a
// successfully uploaded file id.
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

// GET /file/fetch_files?file_ids=<id,id,...> returns metadata for uploaded files.
// Response: { code, msg, data: { biz_code, biz_msg, biz_data: { files: [...] } } }
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
        throw createTypedError(typeForStatus(resp.status), resp.status, `fetch_files HTTP ${resp.status}: ${text.substring(0, 200)}`);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { debugLog(console.log, `[DS-API] fetch_files response is not JSON: ${e.message}`); }
    return extractFetchedFiles(json);
}

// Walk messages, upload every image_url part, and return the ordered file ids.
// Returns { fileIds, uploads, failures }.
async function resolveMessageAttachments(messages, account, agentTag = '', {
    shouldAbort = null,
    // Injectable seams so tests can drive the success branches without real
    // network access, PoW/WASM or a live DS session. Production callers pass
    // nothing and get the module-level implementations.
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
                // Dedup by content hash, not name/size/mime: two distinct files
                // that happen to share those would otherwise collapse into one.
                const key = crypto.createHash('sha256').update(buffer).digest('hex');
                if (seen.has(key)) continue;
                seen.add(key);
                const uploaded = await uploadFile({ buffer, filename, mime, account, agentTag, shouldAbort });
                uploads.push(uploaded);
                fileIds.push(uploaded.id);
            } catch (e) {
                failures.push({ url: String(url).substring(0, 120), error: e.message });
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
    DS_FETCH_TIMEOUT_MS,
    FILE_STATUS_POLL_INTERVAL_MS,
    FILE_STATUS_POLL_TIMEOUT_MS,
    FILE_SUCCESS_STATUSES,
    FILE_FAILURE_STATUSES,
    MAX_UPLOAD_BYTES,
    dsFetch,
    readDSJsonResponse,
    dsChatCompletion,
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
