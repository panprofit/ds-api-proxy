#!/usr/bin/env node
/*
  Opens a disposable Chrome for Testing profile for DeepSeek Web login and extracts
  the minimum auth metadata into $DS_AUTH_DIR/<id>.json.

  Usage:
    npm run auth
    # optional override: CHROME_PATH="{which chrome}" npm run auth

  Default auth starts a clean disposable Chrome for Testing profile and uses
  --use-mock-keychain to avoid macOS Keychain prompts.

  Flow:
    1. Log in at chat.deepseek.com in the opened Chrome profile.
    2. Send one short prompt (for example: ok) so the frontend initializes state.
    3. Return to terminal and press Enter.
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const accounts = require('../lib/accounts');
const env = process.env;
const baseUrl = `https://${env.DS_REMOTE_HOST}`;

const runDir = path.resolve(__dirname, '../.run');
const profileDir = path.join(runDir, '.chrome-for-testing-profile');
// Use a dedicated default port so an older normal-Chrome auth window on 9333 is not reused.
const port = Number(9339);

function shellPatternSafe(s) {
    return String(s).replace(/[\\"']/g, '.');
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {}
}

function killExistingTestingChrome() {
    // pkill lives at /usr/bin/pkill on both Linux and macOS.
    if (!['linux', 'darwin'].includes(process.platform)) return;
    const patterns = [`--remote-debugging-port=${port}`, profileDir].map(
        shellPatternSafe,
    );
    for (const pattern of patterns) {
        try {
            execFileSync('/usr/bin/pkill', ['-f', pattern], {
                stdio: 'ignore',
            });
        } catch {}
    }
    sleepSync(800);
}

function removeProfileSafely(dir) {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 250,
            });
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            if (i === 4) {
                const staleDir = `${dir}.stale-${Date.now()}`;
                fs.renameSync(dir, staleDir);
                try {
                    fs.rmSync(staleDir, {
                        recursive: true,
                        force: true,
                        maxRetries: 3,
                        retryDelay: 250,
                    });
                } catch {}
                console.log(
                    `[auth] Old profile was busy; moved it aside: ${staleDir}`,
                );
                return;
            }
        }
        sleepSync(300);
    }
}

function clearAuthArtifacts() {
    killExistingTestingChrome();
    removeProfileSafely(profileDir);
}

const chromePath = env.CHROME_PATH;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
let activeRl = null;
function ask(q) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    activeRl = rl;
    return new Promise((resolve) =>
        rl.question(q, (ans) => {
            rl.close();
            activeRl = null;
            resolve(ans);
        }),
    );
}
// Close the pending readline prompt. Without this, losing the Promise.race in
// the ENTER prompt leaves readline attached to stdin and keeps the Node event
// loop alive, so the process hangs after cleanup instead of exiting.
function closeAsk() {
    if (activeRl) {
        try {
            activeRl.close();
        } catch {}
        activeRl = null;
    }
}
async function fetchJson(u, opts) {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
    return await r.json();
}
async function devtoolsReady() {
    try {
        return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
        return null;
    }
}
async function waitDevtools() {
    for (let i = 0; i < 80; i++) {
        const v = await devtoolsReady();
        if (v) return v;
        await sleep(250);
    }
    throw new Error('Chrome DevTools endpoint did not start');
}
async function getPageTarget() {
    for (let i = 0; i < 40; i++) {
        const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
        const page =
            targets.find(
                (t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url),
            ) || targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
        await sleep(250);
    }
    throw new Error('No Chrome page target found');
}
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error
                    ? reject(new Error(JSON.stringify(msg.error)))
                    : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
                if (this.events.length > 1000) this.events.shift();
            }
        };
    }
    ready() {
        return new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) =>
            this.pending.set(id, { resolve, reject }),
        );
    }
    close() {
        try {
            this.ws.close();
        } catch {}
    }
}
function parseMaybeJson(s) {
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}
function normalizeToken(raw) {
    if (!raw) return '';
    const parsed = parseMaybeJson(raw);
    if (parsed && typeof parsed === 'object')
        return (
            parsed.value ||
            parsed.token ||
            parsed.access_token ||
            parsed.accessToken ||
            ''
        );
    return String(raw).trim();
}
async function readPageAuth(cdp) {
    const evalRes = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
      const out = {href: location.href, localStorage:{}, sessionStorage:{}, resources: []};
      for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); out.localStorage[k]=localStorage.getItem(k); }
      for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); out.sessionStorage[k]=sessionStorage.getItem(k); }
      out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
      return out;
    })()`,
        returnByValue: true,
    });
    const pageState = evalRes.result.value || {};
    const stores = [
        pageState.localStorage || {},
        pageState.sessionStorage || {},
    ];
    let token = '';
    for (const store of stores) {
        for (const key of [
            'userToken',
            'token',
            'auth_token',
            'access_token',
            'accessToken',
        ]) {
            token = normalizeToken(store[key]);
            if (token) break;
        }
        if (token) break;
    }
    if (!token) {
        for (const store of stores) {
            for (const [k, v] of Object.entries(store)) {
                if (/token/i.test(k)) {
                    token = normalizeToken(v);
                    if (token) break;
                }
            }
            if (token) break;
        }
    }

    const cookieRes = await cdp.send('Network.getAllCookies');
    const cookies = (cookieRes.cookies || []).filter((c) =>
        /deepseek\.com$/.test(c.domain),
    );
    const cookie = cookies.filter(c => ['ds_session_id', 'smidV2'].includes(c.name)).map(c => `${c.name}=${c.value}`).join('; ');

    let hifDliq = '';
    let hifLeim = '';
    for (const ev of cdp.events) {
        const headers = ev.params?.headers || ev.params?.request?.headers;
        if (!headers) continue;
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (
                lk === 'authorization' &&
                !token &&
                /^Bearer\s+/i.test(String(v))
            )
                token = String(v).replace(/^Bearer\s+/i, '');
 
            if (lk === 'x-hif-dliq' && v) hifDliq = String(v);
            if (lk === 'x-hif-leim' && v) hifLeim = String(v);
        }
    }

    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

    return {
        token,
        cookie,
        wasmUrl,
        hifDliq,
        hifLeim
    };
}
function chromeInstallHelp(missingPath) {
    return `Chrome/Chrome for Testing not found${missingPath ? `: ${missingPath}` : ''}.

How to fix:
  Windows PowerShell:
    $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; npm run auth
    # or install Chrome normally: https://www.google.com/chrome/

  macOS:
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run auth
    # or install Chrome for Testing / Google Chrome.

  Linux / Chromium:
    CHROME_PATH=$(which chromium) npm run auth
    # Ubuntu example: sudo apt install chromium-browser || sudo apt install chromium

If Chrome is installed elsewhere, set CHROME_PATH to the real executable path.`;
}

async function main() {
    if (!chromePath) throw new Error(chromeInstallHelp(chromePath));
    if (!fs.existsSync(chromePath))
        throw new Error(chromeInstallHelp(chromePath));
    if (!env.DS_REMOTE_HOST)
        throw new Error('DS_REMOTE_HOST is not set (check your .env / environment).');
    if (!env.DS_AUTH_DIR)
        throw new Error('DS_AUTH_DIR is not set (check your .env / environment).');

    clearAuthArtifacts();

    fs.mkdirSync(profileDir, { recursive: true });

    console.log(
        `[auth] Starting clean Chrome for Testing profile: ${profileDir}`,
    );
    console.log(`[auth] Browser executable: ${chromePath}`);
    const chrome = spawn(
        chromePath,
        [
            `--user-data-dir=${profileDir}`,
            `--remote-debugging-port=${port}`,
            '--use-mock-keychain',
            '--password-store=basic',
            '--disable-sync',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            baseUrl,
        ],
        { stdio: 'ignore', detached: true },
    );
    chrome.unref();

    // Track manual Chrome close (user clicks the X) so we can stop waiting and
    // always clean up the disposable profile instead of leaving it behind.
    let chromeClosed = false;
    let onChromeExit = null;
    const chromeExitPromise = new Promise((resolve) => {
        onChromeExit = resolve;
    });
    chrome.on('exit', () => {
        chromeClosed = true;
        closeAsk();
        if (onChromeExit) onChromeExit();
    });

    // Declared outside try so finally can always close the CDP WebSocket.
    // An open CDP socket keeps the Node event loop alive, which made the
    // process hang after an early return (e.g. manual Chrome close).
    let cdp = null;

    // try/finally guarantees the temp profile is removed no matter how we exit
    // (success, auth failure, manual Chrome close, or an unexpected error).
    try {
        await waitDevtools();
        const target = await getPageTarget();
        cdp = new CDP(target.webSocketDebuggerUrl);
        await cdp.ready();
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');

        console.log(
            '\n[auth] Chrome is open. Log in to DeepSeek in THIS separate window.',
        );
        console.log(
            '[auth] After logging in, send a short message to DeepSeek, for example: hi',
        );
        // Race the ENTER prompt against Chrome being closed manually, so we
        // never hang on the prompt after the user closes the browser window.
        await Promise.race([
            ask(
                '[auth] Once you are logged in and have sent a test message, press ENTER here: ',
            ),
            chromeExitPromise,
        ]);

        if (chromeClosed) {
            console.error(
                '[auth] Chrome was closed before auth could be read. Nothing was saved.',
            );
            process.exitCode = 2;
            return;
        }

        let auth = null;
        for (let i = 0; i < 20; i++) {
            if (chromeClosed) break;
            try {
                auth = await readPageAuth(cdp);
            } catch (e) {
                if (chromeClosed) break;
                throw e;
            }
            if (auth.token && auth.cookie) break;
            await sleep(500);
        }

        if (!auth || !auth.token || !auth.cookie) {
            console.error('[auth] Could not extract both token and cookie from the page. Nothing was saved.');
            process.exitCode = 2;
            return;
        }

        const authDir = path.resolve(env.DS_AUTH_DIR);
        fs.mkdirSync(authDir, { recursive: true });
        const fileName = accounts.accountIdFromCredentials(auth);
        const filePath = path.join(authDir, `${fileName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(auth, null, 2), { mode: 0o600 });
        console.log(`[auth] Saved: ${filePath}`);
    } finally {
        try {
            if (cdp) cdp.close();
        } catch {}
        closeAsk();
        clearAuthArtifacts();
    }
}
// On Ctrl+C / termination, clean up the disposable Chrome profile and process.
let shuttingDown = false;
function handleSignal(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[auth] Received ${sig}; cleaning up...`);
    try {
        clearAuthArtifacts();
    } catch {}
    process.exit(130);
}
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGHUP', () => handleSignal('SIGHUP'));

main().catch((e) => {
    console.error('[auth] ERROR:', e);
    process.exit(1);
});