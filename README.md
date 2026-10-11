# ds-api-proxy

OpenAI-compatible proxy for the DeepSeek (DS) web chat API. It solves DS's
proof-of-work challenge, rotates across multiple auth accounts, keeps a sticky
remote chat session per agent, and translates DS responses (including truncated
tool-call markup) into the OpenAI Chat Completions format.

- Node.js **>= 22** (uses the built-in `fetch`, `AbortSignal.timeout`, `node:test`
  and `--env-file-if-exists`)
- No runtime dependencies — everything is in the standard library.

> **Scope: local proxy for one or a few agents.** This is not a public,
> multi-tenant API gateway. It is designed to run on loopback for a single
> user driving one or a handful of agents (e.g. the pi coding agent — see
> [Client integration (pi agent)](#client-integration-pi-agent)). It has no
> auth, no per-user quota and no metrics; `DS_MAX_CONCURRENT` is a self-protection
> cap (against exhausting CPU on PoW and getting the DS accounts rate-limited
> or blocked), not a multi-user quota. If you need to serve many concurrent
> clients or untrusted users, put an authenticated gateway in front of it.


> **Full details:** endpoints, environment variables, account rotation and
> troubleshooting live in [docs/reference.md](docs/reference.md).


1. Export a DS auth config (token + cookie from a logged-in DS web session):

   ```bash
   export DS_AUTH_DIR=.auth              # a directory of *.json files
   ```

   You can generate the auth file automatically with `npm run auth` (see
   [Auth helper](#auth-helper)) instead of pasting token/cookie by hand.

2. (Optional) Use a `.env` file instead of exporting variables:

   ```bash
   cp .env.example .env
   # edit .env, then
   npm start           # node --env-file-if-exists=.env index.js
   ```

   `.env` is loaded automatically by `npm start` if present; real environment
   variables always take precedence over the file.

3. Start the server:

   ```bash
   npm start           # listens on 127.0.0.1:9876 by default
   # or
   PORT=8080 HOST=0.0.0.0 node index.js
   ```

   Binding a non-loopback `HOST` exposes the proxy — and the DS accounts it
   holds — to the network, and with an empty `DS_ALLOWED_ORIGINS` CORS then
   denies all browser origins (anti-CSRF). Set `DS_ALLOWED_ORIGINS` and front
   it with an authenticated gateway if you really need that; otherwise keep
   the default `HOST=127.0.0.1`.

   On Linux and macOS you can also run it detached in the background, so it
   survives closing the terminal:

   ```bash
   npm run start:bg    # detaches; logs to ./.run/ds-api-proxy.log
   npm run stop:bg     # graceful SIGTERM shutdown
   ```

   `start:bg` records the PID in `./.run/ds-api-proxy.pid`, so `stop:bg` targets
   exactly this instance. Override the paths with `DS_PID_FILE` / `DS_LOG_FILE`,
   or pass `--pid-file` / `--log` (`--force` for SIGKILL) to
   `sh scripts/start.sh` / `sh scripts/stop.sh`.

4. Send a chat completion (OpenAI-compatible):

   ```bash
   curl -s http://127.0.0.1:9876/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -H 'x-agent-session: my-agent' \
     -d '{
       "stream": false,
       "messages": [{"role": "user", "content": "Say hello in one word."}]
     }' | jq
   ```

5. The same conversation over the Responses API:

   ```bash
   curl -s http://127.0.0.1:9876/v1/responses \
     -H 'Content-Type: application/json' \
     -H 'x-agent-session: my-agent' \
     -d '{
       "model": "default",
       "input": "Say hello in one word."
     }' | jq
   ```

### Auth helper

`npm run auth` opens a disposable Chrome for Testing profile, lets you log in to
DeepSeek in that window, and writes the extracted `token`/`cookie` into
`$DS_AUTH_DIR/<id>.json` (mode `0600`).

The server also writes a small `$DS_AUTH_DIR/.account-state.json` (mode `0600`)
to persist per-account runtime state across restarts: cooldown deadlines (so a
long DS mute is not forgotten) and the LRU `lastUsedAt` (so account rotation
does not restart from the first file on every boot). Both are marked dirty on
change and flushed together on the `DS_ACCOUNT_STATE_FLUSH_MS` interval (default
60s), so the request path never does disk I/O. It is not an auth config and is
skipped by the loader; delete it to force a clean slate.

The login email is passed on the command line (`--email` / `-e`) and the
password is prompted for interactively — neither is read from the environment.
Headless mode is opt-in per run with `--headless` / `-H` (or the
`npm run auth:headless` script). Headless auto-fill requires `--email`. To check
existing accounts and re-login any that have expired, use `npm run auth:repair`
(see [Repairing expired accounts](#repairing-expired-accounts)). It requires:

- Chrome/Chromium available locally — set `CHROME_PATH` if it is not on a
  standard path (e.g. `CHROME_PATH=$(which chromium) npm run auth`).
- `DS_AUTH_DIR` set (in the environment or `.env`).

Flow:

1. Run `npm run auth`; a separate Chrome window opens at the DS host.
   - To auto-fill instead, run `npm run auth -- --email me@example.com` and
     enter the password at the prompt.
   - For a headless run use `npm run auth:headless -- --email me@example.com`.
2. Log in and send one short message (e.g. `hi`) so the frontend initializes
   (skip this step when auto-filling).
3. Press ENTER in the terminal. The script extracts the credentials, saves the
   auth file, and cleans up the temporary Chrome profile.

If a token/cookie cannot be extracted, nothing is written and the script exits
with code `2`.

### Deleting remote sessions

DeepSeek keeps every chat session it created upstream. The proxy deletes its own
remote sessions on idle sweep, rollover and graceful shutdown, but a hard kill
(e.g. `SIGKILL`) can leave sessions behind, and repeated runs accumulate them.
`npm run sessions:delete` wipes **all** remote chat sessions for every
configured account via `POST /chat_session/delete_all`:

```bash
npm run sessions:delete                    # clear sessions on every account
npm run sessions:delete -- --dry-run       # show what would run, no requests
npm run sessions:delete -- --account <id>  # only one account (16-char id)
npm run sessions:delete -- --help
```

Accounts are read from `DS_AUTH_DIR` (same loader as the server), requests go
to the configured upstream host, and a `401`/`403`/`429` puts that account into
the usual cooldown. A failure on one account does not abort the others; the script exits
non-zero if any account failed. `--dry-run` performs no network calls.

### Repairing expired accounts

`npm run auth:repair` probes every account in `DS_AUTH_DIR` with a side-effect
free authenticated request (`POST /chat/create_pow_challenge`) and reports which
ones are still valid. An account whose credentials are rejected (HTTP `401`/`403`,
or an HTTP `200` without a PoW challenge — the same signal the proxy's recovery
loop treats as *auth expired / captcha*) is offered a **headless re-login**:

```bash
npm run auth:repair                    # check all accounts, prompt to repair each
npm run auth:repair -- --account <id>  # only one account (16-char content hash)
npm run auth:repair -- --email me@example.com  # reuse this email for the re-login
npm run auth:repair -- --yes           # no per-account confirmation prompt
npm run auth:repair -- --help
```

The probe is read-only: it never creates or deletes a remote session. Re-login
always runs headless (repair is unattended) and asks for the account password on
the terminal. Since the helper names auth files after the login email, the
re-login prompt offers that address as the default (just press ENTER to accept);
`--email` overrides it. Interactive logins that fell back to the content-hash
file name have no email to recover, so the address is prompted for in full. After a successful re-login the fresh credentials are probed again,
and only then is the old auth file removed if the new one landed under a different
name. Accounts that merely failed to respond (network/upstream error) are
reported but never re-logged in. The script exits non-zero if any account could
not be *checked*; declined repairs are not failures.

### Auth file format

Each auth JSON file looks like:

```json
{
  "token": "<bearer token>",
  "cookie": "<cookie header>",
  "wasmUrl": "<PoW WASM module URL>",
  "hifDliq": "<x-hif-dliq header>",
  "hifLeim": "<x-hif-leim header>"
}
```

`token` is the DS bearer token and `cookie` is the `Cookie` header value (the
helper writes the `ds_session_id` and `smidV2` cookies). Both values come from a
logged-in DS web session. The file is named after a content hash of
token+cookie, so re-running `npm run auth` after the credentials change writes a
new file — remove the old one to avoid keeping a stale account around.

The PoW WASM URL is stored per account in its auth config as `wasmUrl` (written
by `npm run auth`), so accounts from different regions can pin their own copy of
the solver.

`hifDliq` / `hifLeim` are optional client-identity values captured from the
browser's outgoing requests during `npm run auth`. When present they are
forwarded upstream as the `x-hif-dliq` / `x-hif-leim` headers; when absent the
proxy sends empty values, which is the normal case today. They exist so the
exact browser identity of an account can be replayed if DeepSeek ever hardens
its client checks.


## Client integration (pi agent)

The primary consumer is the **pi** coding agent, which talks to the proxy as an
OpenAI-compatible provider. All pi-specific behaviour lives on the pi side — the
proxy needs no pi-specific code.

A minimal pi provider entry (`models.json`) looks like:

```json
{
  "providers": {
    "ds-api": {
      "baseUrl": "http://127.0.0.1:9876/v1",
      "api": "openai-responses",
      "apiKey": "no_key",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "sessionAffinityFormat": "openai"
      },
      "models": [
        {
          "id": "deepseek",
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 32000,
          "reasoning": false
        }
      ]
    }
  }
}
```

How those fields map onto the proxy:

- `api: "openai-responses"` -> the proxy's `POST /v1/responses` endpoint (not
  `/v1/chat/completions`).
- `compat.sendSessionAffinityHeaders: true` -> pi sends the session-affinity
  header, which the proxy resolves to `x-agent-session` (see
  [Session routing](#session-routing)). One pi conversation keeps one sticky
  upstream DS session across requests.
- `reasoning: true` -> the proxy surfaces DS thinking in the Responses
  `reasoning` output items and in `output_tokens_details.reasoning_tokens`.
- `input: ["text", "image"]` -> image attachments are uploaded through the
  proxy's upload cache and passed to DS.

Startup order:

1. `npm run auth` — capture (or refresh) a DS account into `DS_AUTH_DIR`.
2. `npm start` (or `npm run start:bg`) — start the proxy on `127.0.0.1:9876`.
3. Start pi — it connects to the `ds-api` provider shown above.

Limitations that bite pi specifically:

- `previous_response_id` is **not** supported (the proxy is stateless); pi must
  keep the conversation history and send it every turn. Continuity comes from
  the affinity header, not from server-side state.
- Hosted tools (`web_search`, `code_interpreter`, MCP) are not executed by the
  proxy. pi runs its own tools and sends back `function_call_output` items.


## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and how to report
a vulnerability privately.


See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for setup, test and style guidelines.

```bash
npm test              # node --test (deterministic suite; discovers test/*.test.js)
npm run test:coverage # tests + coverage thresholds (used by CI)
npm run test:perf     # parser timing budgets (perf/*.perf.js; not in CI)
npm run lint          # eslint .
npm run check         # node --check on index.js and lib/*.js, then eslint .
```

CI runs syntax check + lint, then tests with a coverage gate, on Node 22 and
24 (`.github/workflows/test.yml`). Formatting is pinned by `.editorconfig`
(4-space indent, LF, final newline).

The Node version is pinned by `.nvmrc` (`22`); `nvm use` picks it up.

### Pre-commit hook

The committed `.githooks/pre-commit` (a dependency-free shell script, no
husky/lint-staged) auto-fixes staged `*.js` with `eslint --fix` and re-stages
the result, then runs the same `npm run check` gate CI uses — so a fixable nit
is corrected and a broken/unfixable lint error blocks the commit before it is
made.

It is installed automatically by the npm `prepare` script after `npm install`
(via `scripts/install-hooks.sh`, which points `core.hooksPath` at `.githooks`).
Re-install manually with:

```bash
npm run hooks:install
```
