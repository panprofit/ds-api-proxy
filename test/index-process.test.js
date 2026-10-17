'use strict';
// Process-level paths in index.js that only run under require.main === module:
// the fatal uncaughtException policy and the main()-threw-at-boot catch.
// index.js runs in a child process (like server-env.test.js) so process.exit
// cannot take down the test runner; test/fixtures/process-mode-preload.js
// injects the failure after the relevant handler is installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fixtures', 'process-mode-preload.js');

// A real free port: PORT=0 is clamped to 1 by config.toInt(min: 1), and
// binding port 1 fails with EACCES for a non-root user, which would make the
// server die before the injected failure ever fires.
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function runLauncher(mode, timeoutMs = 8000) {
    const port = await freePort();
    const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'index.js')], {
        env: {
            ...process.env,
            DS_AUTH_DIR: '/nonexistent',
            HOST: '127.0.0.1',
            PORT: String(port),
            DS_TEST_MODE: mode,
            DS_TEST_SERVER_PATH: path.join(ROOT, 'lib', 'server.js'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('child did not exit in time: ' + out));
        }, timeoutMs);
        timer.unref();
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, out });
        });
    });
    return { child, done, log: () => out };
}

test('index.js: an uncaughtException is logged with its stack and exits 1', async () => {
    const { done } = await runLauncher('uncaught');
    const { code, out } = await done;
    assert.equal(code, 1, 'uncaughtException must exit with status 1');
    assert.match(out, /uncaughtException \(exiting\)/);
    assert.match(out, /injected uncaught/);
    assert.match(out, /at /, 'the stack trace must reach the output');
});

test('index.js: a throw from main() at boot is reported as FATAL and exits 1', async () => {
    const { done } = await runLauncher('boot-crash');
    const { code, out } = await done;
    assert.equal(code, 1, 'a boot failure must exit with status 1');
    assert.match(out, /\[DS-API\] FATAL:/);
    assert.match(out, /injected boot failure/);
});

// Start the launcher and wait until it reports listening on its port.
async function startAndWait() {
    const port = await freePort();
    const child = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'index.js')], {
        env: {
            ...process.env,
            DS_AUTH_DIR: '/nonexistent',
            HOST: '127.0.0.1',
            PORT: String(port),
            DS_TEST_MODE: 'sweep-throw',
            DS_TEST_SERVER_PATH: path.join(ROOT, 'lib', 'server.js'),
            DS_TEST_SESSIONS_PATH: path.join(ROOT, 'lib', 'sessions.js'),
            DS_SESSION_SWEEP_INTERVAL_MS: '1000',
            DS_DEBUG: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const done = new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal, out }));
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        if (out.includes('Server on')) break;
        if (child.exitCode !== null) throw new Error('server exited early: ' + out);
        await new Promise(r => setTimeout(r, 50));
    }
    return { child, done, log: () => out };
}
test('index.js: a throwing idle-session sweep is caught, logged and does not kill the server', async () => {
    // The setInterval callback in main() must not let a sweep failure become an
    // uncaughtException (which exits). DS_DEBUG=1 is required because the catch
    // logs through debugLog(). The interval is 1000ms (the config minimum).
    const { child, done, log } = await startAndWait();
    try {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
            if (/sweepIdleSessions failed: injected sweep failure/.test(log())) break;
            await new Promise(r => setTimeout(r, 50));
        }
        assert.match(log(), /sweepIdleSessions failed: injected sweep failure/);
        assert.equal(child.exitCode, null, 'the server must keep running after a failed sweep');
        assert.doesNotMatch(log(), /uncaughtException/);
    } finally {
        child.kill('SIGKILL');
        await done;
    }
});
