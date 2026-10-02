#!/usr/bin/env node
// Delete every remote chat session for every configured account.
//
// DeepSeek exposes POST /chat_session/delete_all, which wipes all chat
// sessions stored upstream for the authenticated account. This is useful after
// a proxy run left sessions behind (e.g. a hard kill that skipped the graceful
// shutdown cleanup) or simply to start every account from a clean slate.
//
// Usage:
//   npm run sessions:delete
//   npm run sessions:delete -- --dry-run
//   npm run sessions:delete -- --account <id>
//
// Auth configs are read from DS_AUTH_DIR (see .env / .env.example). The script
// runs against the configured upstream host.
const {
    loadDSConfig,
    getAccounts,
    markAccountFailure,
} = require('../lib/accounts');
const { dsFetch } = require('../lib/upstream');
const config = require('../lib/config');

function usage() {
    console.log(`Usage: npm run sessions:delete [-- options]

Options:
  --dry-run        Show what would be deleted without calling the upstream API.
  --account <id>   Only run for the account with this id (see the startup log
                   or .auth/*.json filenames; ids are a 16-char content hash).
  --help           Show this help.
`);
}

function parseArgs(argv) {
    const opts = { dryRun: false, accountId: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') opts.dryRun = true;
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg === '--account') {
            opts.accountId = argv[++i] || null;
            if (!opts.accountId) throw new Error('--account requires an id');
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return opts;
}

// POST /chat_session/delete_all for a single account. Returns a structured
// result rather than throwing, so one bad account does not abort the sweep.
async function deleteAllSessionsForAccount(account, { dryRun = false } = {}) {
    const label = `${account.id}`;
    if (dryRun) {
        console.log(`[sessions:delete] ${label}: would POST /chat_session/delete_all`);
        return { accountId: account.id, ok: true, dryRun: true };
    }
    try {
        const resp = await dsFetch('/chat_session/delete_all', {
            method: 'POST',
            headers: account.headers,
            body: '{}',
        });
        const text = await resp.text();
        if (!resp.ok) {
            if ([401, 403, 429].includes(resp.status)) {
                markAccountFailure(account, resp.status, 'chat_session/delete_all', resp.headers.get('retry-after'));
            }
            console.error(`[sessions:delete] ${label}: HTTP ${resp.status}: ${text.substring(0, 200)}`);
            return { accountId: account.id, ok: false, status: resp.status };
        }
        // DS wraps everything in { code, msg, data: { biz_code, biz_msg } }.
        // A non-zero biz_code means the request was rejected despite HTTP 200.
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) {
            console.error(`[sessions:delete] ${label}: non-JSON response: ${text.substring(0, 200)}`);
            return { accountId: account.id, ok: false, status: resp.status };
        }
        const bizCode = json?.data?.biz_code;
        if (bizCode !== undefined && bizCode !== 0) {
            console.error(`[sessions:delete] ${label}: rejected (biz_code=${bizCode}): ${json?.data?.biz_msg || json?.msg || ''}`);
            return { accountId: account.id, ok: false, status: resp.status, bizCode };
        }
        console.log(`[sessions:delete] ${label}: all remote sessions deleted`);
        return { accountId: account.id, ok: true, status: resp.status };
    } catch (e) {
        console.error(`[sessions:delete] ${label}: ${e.message}`);
        return { accountId: account.id, ok: false, error: e.message };
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return; }

    const remoteHost = config.get().remoteHost;

    // Advisory audit: report a missing/empty DS_AUTH_DIR before doing anything.
    loadDSConfig({ fatal: false });
    let accounts = getAccounts();
    if (opts.accountId) {
        accounts = accounts.filter(a => a.id === opts.accountId);
        if (accounts.length === 0) {
            console.error(`[sessions:delete] FATAL: no loaded account with id=${opts.accountId}`);
            process.exitCode = 1;
            return;
        }
    }
    if (accounts.length === 0) {
        console.error(`[sessions:delete] FATAL: no auth accounts loaded from DS_AUTH_DIR=${config.get().authDir || '(unset)'}`);
        process.exitCode = 1;
        return;
    }

    console.log(`[sessions:delete] host=${remoteHost}, accounts=${accounts.length}${opts.dryRun ? ' (dry-run)' : ''}`);

    const results = [];
    for (const account of accounts) {
        results.push(await deleteAllSessionsForAccount(account, { dryRun: opts.dryRun }));
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length > 0) {
        console.error(`[sessions:delete] ${failed.length}/${results.length} account(s) failed.`);
        process.exitCode = 1;
    } else {
        console.log(`[sessions:delete] done: ${results.length}/${results.length} account(s) cleared.`);
    }
}

main().catch((e) => {
    console.error('[sessions:delete] ERROR:', e);
    process.exit(1);
});
