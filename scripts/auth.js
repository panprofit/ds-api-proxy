#!/usr/bin/env node
/*
  DeepSeek Web login helper: opens a disposable browser profile, lets you log
  in (or auto-fills credentials), and extracts the minimum auth metadata into
  $DS_AUTH_DIR/<id>.json.

  Two modes, same implementation:
    npm run auth              visible browser, interactive (log in by hand)
    npm run auth:headless     headless browser (passes --headless)

  Why a browser at all
  --------------------
  POST /api/v0/users/login is protected by an AWS WAF JS-challenge. A plain
  HTTP request gets `202 x-amzn-waf-action: challenge` and never reaches the
  app; the challenge is solved by running the WAF's JS in a real browser
  engine. There is no token-refresh endpoint upstream, so a fresh login is the
  only way to mint credentials.

  All configuration is read through lib/config.js (the single source of truth),
  so this file never touches process.env directly. See lib/config.js for the
  full list of DS_* variables.

  Usage:
    npm run auth
    npm run auth:headless
    DS_LOGIN_EMAIL=me@example.com DS_LOGIN_PASSWORD=secret npm run auth:headless
    CHROME_PATH="$(which chromium)" npm run auth

  Flags:
    --headless, -H        run the browser headless (also DS_HEADLESS=1)
    --help, -h            show this help
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const accounts = require('../lib/accounts');
const config = require('../lib/config');

const runDir = path.resolve(__dirname, '../.run');
const profileDir = path.join(runDir, '.chrome-auth-profile');

function baseUrl() { return `https://${config.get().remoteHost}`; }
function signInUrl() { return `${baseUrl()}/sign_in`; }

// --- args -------------------------------------------------------------------

function parseArgs(argv) {
    const opts = { headless: config.get().headless, help: false };
    for (const arg of argv) {
        if (arg === '--headless' || arg === '-H') opts.headless = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return opts;
}

function usage() {
    console.log(`Usage: npm run auth [-- --headless]

  npm run auth              visible browser, interactive login
  npm run auth:headless     headless browser (--headless)

Config (lib/config.js / .env): DS_AUTH_DIR, CHROME_PATH,
  DS_LOGIN_EMAIL, DS_LOGIN_PASSWORD, DS_HEADLESS=1,
  DS_AUTH_CDP_PORT, DS_LOGIN_FORM_TIMEOUT_MS, DS_LOGIN_TIMEOUT_MS,
  DS_KEEP_PROFILE=1`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {}
}

// --- browser discovery ------------------------------------------------------

function resolveBrowserPath(cfg) {
    if (cfg.chromePath) return cfg.chromePath;
    const candidates = [
        // Linux
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch {}
    }
    return null;
}

function browserInstallHelp() {
    return `Could not find a Chromium/Chrome executable.

Set CHROME_PATH to the real binary, e.g.:
  Linux:   CHROME_PATH=$(which chromium) npm run auth
  macOS:   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run auth
  Windows: set CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe

Or install Chrome: https://www.google.com/chrome/`;
}

// --- profile hygiene --------------------------------------------------------

function shellPatternSafe(s) {
    return String(s).replace(/[\\"']/g, '.');
}

function killExistingBrowser() {
    // pkill lives at /usr/bin/pkill on both Linux and macOS.
    if (!['linux', 'darwin'].includes(process.platform)) return;
    const port = config.get().authCdpPort;
    const patterns = [`--remote-debugging-port=${port}`, profileDir].map(shellPatternSafe);
    for (const pattern of patterns) {
        try {
            execFileSync('/usr/bin/pkill', ['-f', pattern], { stdio: 'ignore' });
        } catch {}
    }
    sleepSync(800);
}

function removeProfileSafely(dir) {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            if (i === 4) {
                const staleDir = `${dir}.stale-${Date.now()}`;
                try {
                    fs.renameSync(dir, staleDir);
                    fs.rmSync(staleDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
                } catch {}
                console.log(`[auth] Old profile was busy; moved it aside: ${staleDir}`);
                return;
            }
        }
        sleepSync(300);
    }
}

function cleanup() {
    killExistingBrowser();
    removeProfileSafely(profileDir);
}

// --- interactive prompt -----------------------------------------------------

let activeRl = null;
function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    activeRl = rl;
    return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); activeRl = null; resolve(ans); }));
}
// Close the pending readline prompt. Without this, losing the Promise.race in
// the ENTER prompt leaves readline attached to stdin and keeps the Node event
// loop alive, so the process hangs after cleanup instead of exiting.
function closeAsk() {
    if (activeRl) {
        try { activeRl.close(); } catch {}
        activeRl = null;
    }
}

// --- CDP client -------------------------------------------------------------

async function fetchJson(u, opts) {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
    return await r.json();
}

async function waitDevtools() {
    const port = config.get().authCdpPort;
    for (let i = 0; i < 80; i++) {
        try {
            return await fetchJson(`http://127.0.0.1:${port}/json/version`);
        } catch {
            await sleep(250);
        }
    }
    throw new Error('Browser DevTools endpoint did not start');
}

async function getPageTarget() {
    const port = config.get().authCdpPort;
    for (let i = 0; i < 40; i++) {
        const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
        const page =
            targets.find((t) => t.type === 'page' && /deepseek\.com/.test(t.url)) ||
            targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
        await sleep(250);
    }
    throw new Error('No browser page target found');
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
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
                if (this.events.length > 2000) this.events.shift();
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
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    close() {
        try { this.ws.close(); } catch {}
    }
}

// --- page helpers -----------------------------------------------------------

function parseMaybeJson(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

function normalizeToken(raw) {
    if (!raw) return '';
    const parsed = parseMaybeJson(raw);
    if (parsed && typeof parsed === 'object') {
        return parsed.value || parsed.token || parsed.access_token || parsed.accessToken || '';
    }
    return String(raw).trim();
}

// Fill an <input> the React way: use the native value setter so React's
// synthetic event system sees the change, then dispatch input/change events.
async function setInputValue(cdp, selectorExpr, value) {
    const expr = `(() => {
        const el = ${selectorExpr};
        if (!el) return 'not-found';
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.value;
}

// Poll until the sign-in form is rendered (the SPA loads it asynchronously).
async function waitForLoginForm(cdp, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await cdp.send('Runtime.evaluate', {
            expression: `!!document.querySelector('input[type=password]')`,
            returnByValue: true,
        });
        if (r.result?.value) return true;
        await sleep(500);
    }
    return false;
}

async function submitLogin(cdp) {
    // Prefer a submit button; fall back to dispatching Enter on the password field.
    const expr = `(() => {
        const byType = document.querySelector('button[type=submit]');
        if (byType) { byType.click(); return 'submit-button'; }
        const btns = [...document.querySelectorAll('button')];
        const login = btns.find(b => /log\\s*in/i.test(b.innerText || ''));
        if (login) { login.click(); return 'login-button'; }
        const pw = document.querySelector('input[type=password]');
        if (pw) {
            pw.focus();
            pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            pw.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            return 'enter-key';
        }
        return 'no-submit';
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.value;
}

async function readPageAuth(cdp) {
    const evalRes = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
            const out = { href: location.href, localStorage: {}, sessionStorage: {}, resources: [] };
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.localStorage[k] = localStorage.getItem(k); }
            for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.sessionStorage[k] = sessionStorage.getItem(k); }
            out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
            return out;
        })()`,
        returnByValue: true,
    });
    const pageState = evalRes.result.value || {};
    const stores = [pageState.localStorage || {}, pageState.sessionStorage || {}];

    let token = '';
    for (const store of stores) {
        for (const key of ['userToken', 'token', 'auth_token', 'access_token', 'accessToken']) {
            token = normalizeToken(store[key]);
            if (token) break;
        }
        if (token) break;
    }
    if (!token) {
        for (const store of stores) {
            for (const [k, v] of Object.entries(store)) {
                if (/token/i.test(k)) { token = normalizeToken(v); if (token) break; }
            }
            if (token) break;
        }
    }

    const cookieRes = await cdp.send('Network.getAllCookies');
    const cookies = (cookieRes.cookies || []).filter((c) => /deepseek\.com$/.test(c.domain));
    const cookie = cookies
        .filter((c) => ['ds_session_id', 'smidV2'].includes(c.name))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

    let hifDliq = '';
    let hifLeim = '';
    for (const ev of cdp.events) {
        const headers = ev.params?.headers || ev.params?.request?.headers;
        if (!headers) continue;
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'authorization' && !token && /^Bearer\s+/i.test(String(v))) {
                token = String(v).replace(/^Bearer\s+/i, '');
            }
            if (lk === 'x-hif-dliq' && v) hifDliq = String(v);
            if (lk === 'x-hif-leim' && v) hifLeim = String(v);
        }
    }

    // Fall back to a known-good wasm URL: the sha3 module is only fetched when
    // the first message is sent, so it may be absent from `resources` if the
    // user logged in but never sent one. upstream.js requires a non-empty
    // wasmUrl to solve PoW, so this fallback keeps the saved config usable.
    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

    return { token, cookie, wasmUrl, hifDliq, hifLeim };
}

// --- main -------------------------------------------------------------------

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`[auth] ${e.message}`);
        usage();
        process.exitCode = 1;
        return;
    }
    if (opts.help) { usage(); return; }

    const cfg = config.get();
    if (!cfg.authDir) throw new Error('DS_AUTH_DIR is not set (check your .env / environment).');

    const browserPath = resolveBrowserPath(cfg);
    if (!browserPath) throw new Error(browserInstallHelp());
    if (!fs.existsSync(browserPath)) throw new Error(browserInstallHelp());

    const headless = opts.headless;
    const autoFill = Boolean(cfg.loginEmail && cfg.loginPassword);

    cleanup();
    fs.mkdirSync(profileDir, { recursive: true });

    console.log(`[auth] browser: ${browserPath}`);
    console.log(`[auth] profile: ${profileDir}`);
    console.log(`[auth] mode: ${headless ? 'headless' : 'visible'}${autoFill ? ' + autofill' : ' (interactive)'}`);

    const args = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${cfg.authCdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--use-mock-keychain',
        '--password-store=basic',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-dev-shm-usage',
    ];
    if (headless) args.push('--headless=new', '--disable-gpu');
    if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
    args.push(signInUrl());

    const browser = spawn(browserPath, args, { stdio: 'ignore', detached: true });
    browser.unref();

    // Track manual browser close (user clicks the X) so we can stop waiting and
    // always clean up the disposable profile instead of leaving it behind.
    let browserClosed = false;
    const browserExitPromise = new Promise((resolve) => {
        browser.on('exit', () => { browserClosed = true; closeAsk(); resolve(); });
    });

    // Declared outside try so finally can always close the CDP WebSocket. An
    // open CDP socket keeps the Node event loop alive, which would make the
    // process hang after an early return (e.g. manual browser close).
    let cdp = null;

    try {
        await waitDevtools();
        const target = await getPageTarget();
        cdp = new CDP(target.webSocketDebuggerUrl);
        await cdp.ready();
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Network.enable');

        if (autoFill) {
            console.log('[auth] waiting for the sign-in form...');
            const formReady = await waitForLoginForm(cdp, cfg.loginFormTimeoutMs);
            if (!formReady) {
                throw new Error('Sign-in form did not appear; the page may be blocked (CloudFront/WAF) or the layout changed.');
            }
            console.log('[auth] filling credentials...');
            // The email/phone field has no name attribute; target by placeholder.
            const emailSelector = `document.querySelector('input[placeholder*="Phone"], input[placeholder*="email" i], input[type=text]')`;
            const passwordSelector = `document.querySelector('input[type=password]')`;
            const r1 = await setInputValue(cdp, emailSelector, cfg.loginEmail);
            const r2 = await setInputValue(cdp, passwordSelector, cfg.loginPassword);
            if (r1 === 'not-found' || r2 === 'not-found') {
                throw new Error('Login form fields not found; the sign-in page layout may have changed.');
            }
            await sleep(400);
            const how = await submitLogin(cdp);
            console.log(`[auth] submitted login (${how})`);
        } else {
            if (headless) {
                console.warn('[auth] No DS_LOGIN_EMAIL/DS_LOGIN_PASSWORD set, but running headless.');
                console.warn('[auth] Run `npm run auth` (visible) to log in manually, or provide credentials.');
            }
            console.log('\n[auth] Browser is open. Log in to DeepSeek in THIS separate window.');
            console.log('[auth] After logging in, send a short message to DeepSeek, for example: hi');
            // Race the ENTER prompt against the browser being closed manually,
            // so we never hang on the prompt after the user closes the window.
            await Promise.race([
                ask('[auth] Once you are logged in and have sent a test message, press ENTER here: '),
                browserExitPromise,
            ]);
            if (browserClosed) {
                console.error('[auth] Browser was closed before auth could be read. Nothing was saved.');
                process.exitCode = 2;
                return;
            }
        }

        // Wait for a successful login: token + cookie present.
        const deadline = Date.now() + cfg.loginTimeoutMs;
        let auth = null;
        let lastHref = '';
        while (Date.now() < deadline) {
            if (browserClosed) break;
            try {
                auth = await readPageAuth(cdp);
                const hrefRes = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
                lastHref = hrefRes.result?.value || '';
            } catch {
                if (browserClosed) break;
                await sleep(500);
                continue;
            }
            if (auth.token && auth.cookie) break;
            await sleep(750);
        }

        if (browserClosed) {
            console.error('[auth] Browser was closed before auth could be read. Nothing was saved.');
            process.exitCode = 2;
            return;
        }

        if (!auth || !auth.token || !auth.cookie) {
            console.error(`[auth] Could not extract both token and cookie (last URL: ${lastHref}).`);
            console.error('[auth] Check that the login succeeded (wrong password? captcha? 2FA?).');
            process.exitCode = 2;
            return;
        }

        const authDir = path.resolve(cfg.authDir);
        fs.mkdirSync(authDir, { recursive: true });
        const fileName = accounts.accountIdFromCredentials(auth);
        const filePath = path.join(authDir, `${fileName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(auth, null, 2), { mode: 0o600 });
        console.log(`[auth] Saved: ${filePath}`);
    } finally {
        try { if (cdp) cdp.close(); } catch {}
        closeAsk();
        if (!cfg.keepProfile) cleanup();
    }
}

// On Ctrl+C / termination, clean up the disposable browser profile and process.
let shuttingDown = false;
function handleSignal(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[auth] Received ${sig}; cleaning up...`);
    try { cleanup(); } catch {}
    process.exit(130);
}
process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGHUP', () => handleSignal('SIGHUP'));

main().catch((e) => {
    console.error('[auth] ERROR:', e.message);
    process.exit(1);
});
