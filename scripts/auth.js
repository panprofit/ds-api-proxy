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
    npm run auth -- --email me@example.com
    npm run auth:headless -- --email me@example.com
    npm run auth:repair                     check all accounts, re-login broken ones
    CHROME_PATH="$(which chromium)" npm run auth

  Flags:
    --email, -e <email>   auto-fill the login form; password is prompted
    --headless, -H        run the browser headless
    --repair              validate every account and offer a headless re-login
    --account <id>        with --repair: only this account
    --yes, -y             with --repair: skip the per-account confirmation
    --help, -h            show this help
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const accounts = require('../lib/accounts');
const config = require('../lib/config');
const { dsFetch } = require('../lib/upstream');

const runDir = path.resolve(__dirname, '../.run');
const profileDir = path.join(runDir, '.chrome-auth-profile');

function baseUrl() { return `https://${config.get().remoteHost}`; }
function signInUrl() { return `${baseUrl()}/sign_in`; }

// Name the saved auth file after the login email when it is known (headless /
// autofill), so files are human-readable and re-authenticating the same
// account overwrites its file instead of accumulating content-hash names.
// Falls back to the token+cookie hash for interactive logins where no email is
// available. The loader keys accounts by that content hash (not the file name),
// so this naming is purely cosmetic and safe to change.
function emailSlug(email) {
    return String(email || '').trim().replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 64);
}

// Recover the login identifier from the captured POST /api/v0/users/login
// request. Interactive (visible) logins have no --email, and the form value is
// destroyed once the SPA navigates away, so the request body is the only place
// the email survives. Returns '' when the endpoint or payload
// shape differs (e.g. a form-urlencoded body), leaving callers to fall back
// to the content hash.
function emailFromLoginPost(events) {
    for (const ev of events) {
        if (ev.method !== 'Network.requestWillBeSent') continue;
        const req = ev.params && ev.params.request;
        if (!req || req.method !== 'POST' || !/\/api\/v0\/users\/login/.test(req.url)) continue;
        const body = parseMaybeJson(req.postData);
        if (body && typeof body === 'object') {
            const id = body.email || body.mobile || body.phone || '';
            if (id) return String(id).trim();
        }
    }
    return '';
}

function authFileName(email, auth, capturedEmail) {
    const slug = emailSlug(email || capturedEmail || '');
    if (slug) return slug;
    return accounts.accountIdFromCredentials(auth);
}

// Best-effort recovery of the login email from an auth file name. The helper
// names files after the email slug (see authFileName), so for a normal address
// (letters/digits/._@-) the basename IS the email and needs no re-typing. The
// slug is lossy (other chars -> '_', truncated to 64) and interactive logins
// fall back to the content hash, so this is only a suggestion the operator can
// override at the prompt; anything not email-shaped yields ''.
function emailFromFileName(file) {
    const base = path.basename(String(file || ''), '.json');
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base) ? base : '';
}

// CloudFront rejects any request whose User-Agent contains "HeadlessChrome"
// with HTTP 403, so a plain --headless run never reaches the login form. In
// headless mode we present this ordinary desktop Chrome UA instead (see the
// CDP setup in main).
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// --- args -------------------------------------------------------------------

function parseArgs(argv) {
    const opts = { headless: false, email: '', repair: false, accountId: null, yes: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--headless' || arg === '-H') opts.headless = true;
        else if (arg === '--repair') opts.repair = true;
        else if (arg === '--yes' || arg === '-y') opts.yes = true;
        else if (arg === '--email' || arg === '-e') {
            const value = argv[++i];
            if (value === undefined) throw new Error('--email requires a value');
            opts.email = value;
        } else if (arg.startsWith('--email=')) {
            opts.email = arg.slice('--email='.length);
        } else if (arg === '--account') {
            const value = argv[++i];
            if (!value) throw new Error('--account requires an id');
            opts.accountId = value;
        } else if (arg.startsWith('--account=')) {
            opts.accountId = arg.slice('--account='.length);
        } else if (arg === '--help' || arg === '-h') opts.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return opts;
}

function usage() {
    console.log(`Usage: npm run auth [-- --headless] [-- --email <email>] [-- --repair]

  npm run auth                       visible browser, interactive login
  npm run auth:headless              headless browser (--headless)
  npm run auth -- --email me@x.com   auto-fill; password is prompted
  npm run auth:repair                check every account; re-login broken ones

  --headless, -H    run the browser headless
  --email, -e       account email to auto-fill (password prompted)
  --repair          probe all accounts and offer a headless re-login
  --account <id>    with --repair: only this account (16-char content hash)
  --yes, -y         with --repair: skip the per-account confirmation
  --help, -h        show this help

Config (lib/config.js / .env): DS_AUTH_DIR, CHROME_PATH,
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

// Like ask(), but returns `def` when the operator just presses ENTER. Used so
// an already-known value (e.g. the email recovered from the auth file name)
// can be accepted without re-typing it.
async function askDefault(q, def) {
    const ans = (await ask(q)).trim();
    return ans || def;
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

// Prompt for the password without echoing it. Uses raw mode on a TTY; when
// stdin is not a TTY (piped input) it falls back to a normal line read.
function askHidden(q) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        stdout.write(q);
        if (!stdin.isTTY) {
            const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
            rl.once('line', (line) => { rl.close(); stdout.write('\n'); resolve(line); });
            return;
        }
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let input = '';
        const onData = (ch) => {
            for (const c of String(ch)) {
                if (c === '\n' || c === '\r' || c === '\u0004') {
                    stdin.removeListener('data', onData);
                    stdin.setRawMode(wasRaw || false);
                    stdin.pause();
                    stdout.write('\n');
                    resolve(input);
                    return;
                } else if (c === '\u0003') {
                    stdin.removeListener('data', onData);
                    stdin.setRawMode(wasRaw || false);
                    stdin.pause();
                    stdout.write('\n');
                    process.exit(130);
                } else if (c === '\u007f' || c === '\b') {
                    input = input.slice(0, -1);
                } else {
                    input += c;
                }
            }
        };
        stdin.on('data', onData);
    });
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

// A DS bearer token is a long opaque string (JWT / hex). Reject anything that
// is obviously NOT one, so a metadata value such as a numeric expiry timestamp
// stored under a *token*-looking key cannot be mistaken for the credential.
function looksLikeToken(value) {
    const v = String(value || '').trim();
    if (v.length < 20) return false;
    // A pure number is a timestamp/counter (e.g. token_expire), never a token.
    if (/^\d+$/.test(v)) return false;
    return true;
}

// Keys that merely *contain* "token" but hold metadata, not the credential.
const TOKEN_METADATA_KEY = /(expire|expiry|expires|time|ttl|timestamp|issued|refresh|version)/i;

function normalizeToken(raw) {
    if (raw == null) return '';
    let value = raw;
    const parsed = parseMaybeJson(raw);
    if (parsed && typeof parsed === 'object') {
        value = parsed.value || parsed.token || parsed.access_token || parsed.accessToken || '';
    }
    value = String(value || '').trim();
    // Handle a double-encoded string (a JSON string wrapping the token).
    if (/^".*"$/.test(value)) {
        const unwrapped = parseMaybeJson(value);
        if (typeof unwrapped === 'string') value = unwrapped.trim();
    }
    return looksLikeToken(value) ? value : '';
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
                if (!/token/i.test(k)) continue;
                // Skip metadata keys like token_expire_time; only a key that
                // plausibly holds the credential itself is considered.
                if (TOKEN_METADATA_KEY.test(k)) continue;
                token = normalizeToken(v);
                if (token) break;
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

// Open the disposable browser and capture credentials. Returns
// { ok: true, filePath } on success, or { ok: false, reason } when nothing was
// saved (browser closed, credentials not found). Throws on setup errors
// (missing DS_AUTH_DIR / browser). Shared by the normal login and --repair.
async function runLoginFlow({ headless = false, email = '', password = '' } = {}) {
    const cfg = config.get();
    if (!cfg.authDir) throw new Error('DS_AUTH_DIR is not set (check your .env / environment).');

    const browserPath = resolveBrowserPath(cfg);
    if (!browserPath) throw new Error(browserInstallHelp());
    if (!fs.existsSync(browserPath)) throw new Error(browserInstallHelp());

    const autoFill = Boolean(email && password);

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
    // --no-sandbox is required for headless in restricted environments
    // (containers/CI without user namespaces), where the Chromium zygote
    // aborts with sys_chroot()/Zygote errors and the DevTools endpoint never
    // comes up. This is a one-shot local login helper, not a browsing session,
    // so the sandbox trade-off is acceptable. Visible mode keeps the sandbox
    // unless running as root.
    if (headless) args.push('--headless=new', '--disable-gpu', '--no-sandbox');
    else if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
    // Start on a blank page and navigate via CDP (see below). Passing the
    // sign-in URL as a browser argument would send its first request with the
    // default HeadlessChrome User-Agent, which CloudFront answers with HTTP
    // 403 before the page (and the WAF challenge) ever loads.
    args.push('about:blank');

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

        if (headless) {
            // Mask the headless fingerprint: a desktop UA (else CloudFront
            // 403s) and no navigator.webdriver. The WAF challenge is still
            // solved by the real JS engine; this only stops the request being
            // rejected on sight.
            await cdp.send('Network.setUserAgentOverride', {
                userAgent: DESKTOP_UA,
                acceptLanguage: 'en-US,en;q=0.9',
                platform: 'MacIntel',
            });
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
                source: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });',
            });
        }
        // Navigate through CDP so the UA override above applies to the very
        // first request. The AWS WAF JS-challenge then runs before the SPA
        // renders, so allow a moment before polling for the form.
        await cdp.send('Page.navigate', { url: signInUrl() });
        await sleep(1500);

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
            const r1 = await setInputValue(cdp, emailSelector, email);
            const r2 = await setInputValue(cdp, passwordSelector, password);
            if (r1 === 'not-found' || r2 === 'not-found') {
                throw new Error('Login form fields not found; the sign-in page layout may have changed.');
            }
            await sleep(400);
            const how = await submitLogin(cdp);
            console.log(`[auth] submitted login (${how})`);
        } else {
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
                return { ok: false, reason: 'browser-closed' };
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
            return { ok: false, reason: 'browser-closed' };
        }

        if (!auth || !auth.token || !auth.cookie) {
            console.error(`[auth] Could not extract both token and cookie (last URL: ${lastHref}).`);
            console.error('[auth] Check that the login succeeded (wrong password? captcha? 2FA?).');
            return { ok: false, reason: 'no-credentials' };
        }

        const authDir = path.resolve(cfg.authDir);
        fs.mkdirSync(authDir, { recursive: true });
        const capturedEmail = emailFromLoginPost(cdp.events);
        const fileName = authFileName(email, auth, capturedEmail);
        if (!email && capturedEmail) {
            console.log(`[auth] account email (from login request): ${capturedEmail}`);
        }
        const filePath = path.join(authDir, `${fileName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(auth, null, 2), { mode: 0o600 });
        console.log(`[auth] Saved: ${filePath}`);
        return { ok: true, filePath, auth };
    } finally {
        try { if (cdp) cdp.close(); } catch {}
        closeAsk();
        if (!cfg.keepProfile) cleanup();
    }
}

// --- repair: validate all accounts, offer headless re-login -----------------

// Probe one account against the cheapest authenticated endpoint. Returns:
//   { status: 'ok' }                       credentials work
//   { status: 'expired', detail }          auth expired / captcha / WAF block
//   { status: 'error', detail }            network or unexpected upstream error
// We use /chat/create_pow_challenge: it requires a valid session (so it detects
// expired auth / captcha) but has no side effects (unlike /chat_session/create,
// which would leak a remote session we do not clean up).
async function probeAccount(account) {
    let resp;
    try {
        resp = await dsFetch('/chat/create_pow_challenge', {
            method: 'POST',
            headers: account.headers,
            body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
        });
    } catch (e) {
        return { status: 'error', detail: e.message };
    }
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
        return { status: 'expired', detail: `HTTP ${resp.status}` };
    }
    if (!resp.ok) {
        return { status: 'error', detail: `HTTP ${resp.status}` };
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; }
    catch { return { status: 'error', detail: 'non-JSON response (WAF/captcha page?)' }; }
    // HTTP 200 without a challenge means the credentials are unusable. This
    // mirrors lib/upstream.solvePowForPath, which throws auth_expired for the
    // same condition, so repair and the proxy agree on what "expired" means.
    if (!json?.data?.biz_data?.challenge) {
        const bizCode = json?.data?.biz_code;
        const msg = json?.data?.biz_msg || json?.msg || 'no PoW challenge in response';
        return { status: 'expired', detail: `${msg}${bizCode ? ` (biz_code=${bizCode})` : ''}` };
    }
    return { status: 'ok' };
}

// Validate every loaded account and, for each broken one, offer to re-login in
// headless mode (requires a browser + --email for that account, or falls back
// to asking the operator).
async function runRepair(opts) {
    const cfg = config.get();
    if (!cfg.authDir) throw new Error('DS_AUTH_DIR is not set (check your .env / environment).');

    accounts.loadDSConfig({ fatal: false });
    let list = accounts.getAccounts();
    if (opts.accountId) {
        list = list.filter(a => a.id === opts.accountId);
        if (list.length === 0) throw new Error(`no loaded account with id=${opts.accountId}`);
    }
    if (list.length === 0) throw new Error(`no auth accounts loaded from DS_AUTH_DIR=${cfg.authDir || '(unset)'}`);

    console.log(`[auth:repair] host=${cfg.remoteHost}, accounts=${list.length}`);
    const results = [];
    for (const account of list) {
        const label = `${path.basename(account.file)} (id=${account.id})`;
        process.stdout.write(`[auth:repair] ${label}: checking... `);
        const probe = await probeAccount(account);
        if (probe.status === 'ok') {
            console.log('ok');
            results.push({ account, status: 'ok' });
        } else {
            console.log(probe.status === 'expired' ? `EXPIRED (${probe.detail})` : `error (${probe.detail})`);
            results.push({ account, status: probe.status, detail: probe.detail });
        }
    }

    const broken = results.filter(r => r.status !== 'ok');
    const expired = broken.filter(r => r.status === 'expired');
    if (broken.length === 0) {
        console.log(`[auth:repair] all ${results.length} account(s) are valid.`);
        return;
    }
    if (expired.length === 0) {
        console.error(`[auth:repair] ${broken.length} account(s) could not be checked (network/upstream error); not re-logging in.`);
        process.exitCode = 1;
        return;
    }

    // A browser is required for re-login, but only check for one lazily (after
    // the operator confirms) so a missing browser does not abort the whole run.
    const browserPath = resolveBrowserPath(cfg);
    const email = opts.email.trim();

    for (const r of expired) {
        const label = `${path.basename(r.account.file)} (id=${r.account.id})`;
        // The email is usually recoverable from the file name, so offer it as
        // the default (ENTER accepts) instead of asking the operator to retype
        // what the script already knows. --email overrides it entirely.
        const suggested = email || emailFromFileName(r.account.file);
        if (!opts.yes) {
            const ans = (await ask(`[auth:repair] Re-login ${label} now? [y/N] `)).trim().toLowerCase();
            if (ans !== 'y' && ans !== 'yes') { console.log(`[auth:repair] skipping ${label}.`); continue; }
        }
        if (!browserPath) {
            console.error(`[auth:repair] ${label}: ${browserInstallHelp()}`);
            continue;
        }
        let acctEmail;
        if (email) {
            acctEmail = email;
        } else if (suggested) {
            acctEmail = await askDefault(`[auth:repair] Email for account ${r.account.id} [${suggested}]: `, suggested);
        } else {
            acctEmail = (await ask(`[auth:repair] Email for account ${r.account.id}: `)).trim();
        }
        if (!acctEmail) { console.error(`[auth:repair] no email for ${label}; skipping.`); continue; }
        console.log(`[auth:repair] ${label}: using email ${acctEmail}`);
        const password = await askHidden(`[auth:repair] Password for ${acctEmail}: `);
        if (!password) { console.error(`[auth:repair] empty password for ${label}; skipping.`); continue; }

        let login;
        try {
            // Always headless: repair is unattended and the operator is at the
            // terminal for the password, not sitting at a browser window.
            login = await runLoginFlow({ headless: true, email: acctEmail, password });
        } catch (e) {
            console.error(`[auth:repair] ${label}: re-login failed: ${e.message}`);
            continue;
        }
        if (!login.ok) {
            console.error(`[auth:repair] ${label}: re-login did not produce credentials (${login.reason}).`);
            continue;
        }
        // The new file may be written under a different name than the broken
        // one (e.g. the email slug changed). Verify the freshly saved file
        // itself, then remove the stale file if it is now a different path.
        const fresh = { id: accounts.accountIdFromCredentials(login.auth), file: login.filePath, config: login.auth, headers: accounts.buildBaseHeaders(login.auth) };
        process.stdout.write(`[auth:repair] ${label}: verifying new credentials... `);
        const verify = await probeAccount(fresh);
        if (verify.status !== 'ok') {
            console.log(verify.status === 'expired' ? `STILL EXPIRED (${verify.detail})` : `error (${verify.detail})`);
            console.error(`[auth:repair] ${label}: new credentials did not validate; leaving files untouched.`);
            continue;
        }
        console.log('ok');
        const oldPath = path.resolve(r.account.file);
        const newPath = path.resolve(login.filePath);
        if (oldPath !== newPath && fs.existsSync(oldPath)) {
            try { fs.rmSync(oldPath); console.log(`[auth:repair] ${label}: removed stale file ${oldPath}`); }
            catch (e) { console.error(`[auth:repair] ${label}: could not remove stale file ${oldPath}: ${e.message}`); }
        }
        console.log(`[auth:repair] ${label}: repaired -> ${login.filePath}`);
    }
}

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

    if (opts.repair) {
        await runRepair(opts);
        return;
    }

    const headless = opts.headless;
    const email = opts.email.trim();
    if (headless && !email) {
        throw new Error('--headless requires --email (there is no visible window to log in by hand).');
    }

    // Password is always prompted, never read from the environment. Read it
    // before opening the browser so the terminal is free and the profile is
    // only created once credentials are in hand.
    let password = '';
    if (email) {
        password = await askHidden(`[auth] Password for ${email}: `);
        if (!password) throw new Error('Empty password; aborting.');
    }

    const result = await runLoginFlow({ headless, email, password });
    if (!result.ok) process.exitCode = 2;
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
