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

## Quickstart

1. Export a DS auth config (token + cookie from a logged-in DS web session):

   ```bash
   export DS_AUTH_DIR=.auth              # a directory of *.json files
   export DS_REMOTE_HOST=chat.deepseek.com
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
       "model": "deepseek-chat",
       "input": "Say hello in one word."
     }' | jq
   ```

### Auth helper

`npm run auth` opens a disposable Chrome for Testing profile, lets you log in to
DeepSeek in that window, and writes the extracted `token`/`cookie` into
`$DS_AUTH_DIR/<id>.json` (mode `0600`). It requires:

- Chrome/Chromium available locally — set `CHROME_PATH` if it is not on a
  standard path (e.g. `CHROME_PATH=$(which chromium) npm run auth`).
- `DS_REMOTE_HOST` and `DS_AUTH_DIR` set (in the environment or `.env`).

Flow:

1. Run `npm run auth`; a separate Chrome window opens at the DS host.
2. Log in and send one short message (e.g. `hi`) so the frontend initializes.
3. Press ENTER in the terminal. The script extracts the credentials, saves the
   auth file, and cleans up the temporary Chrome profile.

If a token/cookie cannot be extracted, nothing is written and the script exits
with code `2`.

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

## Endpoints

| Method | Path                     | Description                                  |
|--------|--------------------------|----------------------------------------------|
| POST   | `/v1/chat/completions`   | OpenAI Chat Completions (`stream: true|false`) |
| POST   | `/v1/responses`          | OpenAI Responses API (`stream: true|false`)    |
| GET    | `/health`                | Liveness/readiness JSON report (see below).    |

The proxy is meant to run on loopback; `/health` is its only non-completion
endpoint. The primary consumer is the pi coding agent, which uses
`/v1/responses` — see [Client integration (pi agent)](#client-integration-pi-agent).

### `GET /health`

Returns a JSON liveness/readiness report. To a **loopback peer** the full
report is: `status` (`ok` / `shutting_down`), `uptime_ms`, `remote_host`, an
`accounts` summary (`total` / `usable` / `available` / `cooling`), `sessions`,
`shutting_down`, and - while the server is up - a `concurrency` block
(`in_flight` / `limit` / `available`). A non-loopback caller gets only the
minimal `{ status, shutting_down }` (see the disclosure note below).

- `200` while healthy, `503` while draining (so a supervisor stops routing
  work during graceful shutdown), `405` for any method other than `GET`.
- The full report (uptime, upstream host, account counts, sessions,
  concurrency) is returned only to a **loopback peer**. Any non-loopback
  caller gets just `{ status, shutting_down }`, so the endpoint cannot be used
  for reconnaissance on a network-exposed bind.

Both endpoints share the same upstream session, account rotation and recovery
machinery, so an `x-agent-session` pinned conversation can move between them
without losing context.

### `/v1/responses` notes

- **Request.** The conversation is passed via `input` (a string, or an array of
  items: `message`, `function_call`, `function_call_output`); `instructions`
  becomes the system prompt. `tools` use the flat Responses shape
  (`{type:"function", name, description, parameters}`) and are normalized
  internally. `stream` and `stream_options.include_usage` are honored.
- **Response.** `output` is an array of typed items (`reasoning`, `message`,
  `function_call`); text is also mirrored in `output_text`. Usage uses
  `input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens`.
- **Streaming.** Server-Sent Events. The event sequence includes
  `response.created`, `response.in_progress`,
  `response.output_item.added` / `response.output_item.done`,
  `response.content_part.added` / `response.content_part.done`,
  `response.output_text.delta` / `response.output_text.done`,
  `response.function_call_arguments.delta` /
  `response.function_call_arguments.done`, the reasoning events
  `response.reasoning_summary_part.added`,
  `response.reasoning_summary_text.delta` / `response.reasoning_summary_text.done`,
  and a terminal `response.completed` (or `response.incomplete`), then
  `data: [DONE]`. Treat unknown event types as ignorable.
- **Not supported:** server-side state via `previous_response_id` (the proxy is
  stateless; use `x-agent-session` for continuity) and hosted tools
  (`web_search`, `code_interpreter`, MCP) — there is nothing to execute them.

### Session routing

The per-agent session key is taken from the first of these request headers that
is present: `x-agent-session`, `x-session-affinity`, `x-session-id`,
`session_id`, `x-client-request-id`, the `session`/`user` body fields, or the
remote address (localhost -> `dev-agent`). Use `x-agent-session` to pin a
conversation to a specific upstream session; change it to start a fresh one.

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
          "contextWindow": 384000,
          "maxTokens": 32000,
          "reasoning": true
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

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9876` | HTTP listen port (1–65535). |
| `HOST` | `127.0.0.1` | HTTP listen host. **On a non-loopback bind with an empty `DS_ALLOWED_ORIGINS`, CORS denies all browser origins (anti-CSRF); set the allowlist to permit specific origins.** |
| `DS_REMOTE_HOST` | — (**required**) | Upstream host, e.g. `chat.deepseek.com`. Server exits if unset. |
| `DS_AUTH_DIR` | — (needed for any accounts) | Directory scanned for `*.json` auth configs (sorted). There is no default: when unset, no accounts load and every completion returns 503. Audited at startup (unset/missing dir, no `*.json` files, or none loading all produce a clear log line). |
| `DS_ACCOUNT_COOLDOWN_MS` | `600000` (10 min) | Cooldown after an HTTP 401/403/429 account failure. |
| `DS_CLIENT_LOCALE` | `en` | Default `x-client-locale` sent upstream; per-account `locale` overrides it. |
| `DS_CLIENT_TIMEZONE_OFFSET` | `0` | Default `x-client-timezone-offset` sent upstream; per-account `timezone_offset` overrides it. |
| `DS_MAX_CONCURRENT` | `24` | Max simultaneous in-flight completions. |
| `DS_REQUEST_DEADLINE_MS` | `120000` | Per-request deadline before recovery gives up. |
| `DS_MAX_RETRIES` | `2` | Empty-response retries per account (0–10). |
| `DS_MAX_UPSTREAM_RETRIES` | `3` | Same-account retries when DS itself reports a transient outage (`finish_reason=generation_err` / "Server temporarily unavailable."). Rotating accounts cannot help here (all share the same upstream), so the current account is retried instead of parked (0–10). |
| `DS_MAX_CONTINUATION` | `2` | Max auto-continuation rounds for long/length-finished responses (0–10). |
| `DS_MAX_REASONING_CONTINUATION` | `2` | Max rounds to turn a reasoning-only response (thinking but no final text) into a visible answer, avoiding a manual `continue` (0–10). |
| `DS_MAX_MARKUP_COMPLETION` | `2` | Max completion rounds for truncated tool-call markup (0–10). |
| `DS_CONTINUATION_SIZE_THRESHOLD` | `25000` | Response length (chars) above which auto-continuation kicks in. |
| `DS_RECOVERY_RETRY_DELAY_MS` | `500` | Base delay between recovery retries (scaled, capped at 3×). |
| `DS_MALFORMED_TOOL_CALL_COOLDOWN_MS` | `5000` | Cooldown after malformed tool-call markup (applied when the account is finally rotated). |
| `DS_MAX_SESSION_RESETS_PER_ACCOUNT` | `3` | Consecutive remote-session recreations on the same account to recover from malformed tool-call markup before the account is rotated. |
| `DS_SESSION_TTL_MS` | `7200000` (2 h) | Remote session TTL before rollover. |
| `DS_MAX_SESSIONS` | `1000` | Max concurrent agent sessions. |
| `DS_SESSION_SWEEP_INTERVAL_MS` | `600000` (10 min) | Interval between idle-session / stale-upload sweeps. |
| `DS_UPLOAD_CACHE_TTL_MS` | `21600000` (6 h) | Upload cache TTL. |
| `DS_MAX_UPLOAD_BYTES` | `26214400` (25 MB) | Max size of a single uploaded attachment. |
| `DS_MAX_BODY_BYTES` | `10485760` (10 MB) | Max size of an incoming request body. |
| `DS_BODY_READ_TIMEOUT_MS` | `30000` | Max time to receive a full body before `408`. |
| `DS_HEADERS_TIMEOUT_MS` | `60000` | Socket cap on sending request headers. |
| `DS_REQUEST_TIMEOUT_MS` | `300000` | Socket cap on the whole request. |
| `DS_FETCH_TIMEOUT_MS` | `60000` | Timeout for DS fetch calls. |
| `DS_FILE_POLL_INTERVAL_MS` | `1000` | Interval when polling uploaded file status. |
| `DS_FILE_POLL_TIMEOUT_MS` | `60000` | Timeout waiting for an uploaded file to become `SUCCESS`. |
| `DS_ALLOWED_ORIGINS` | — | Comma-separated CORS origin allowlist. When empty, the request Origin is reflected only on a loopback `HOST`; on a non-loopback bind no browser origin is allowed (deny-by-default). |
| `DS_STREAM_KEEPALIVE_MS` | `15000` | SSE keep-alive interval in ms; `0` disables. |
| `DS_SHUTDOWN_GRACE_MS` | `15000` | Grace period for draining in-flight requests on SIGTERM/SIGINT, and for the final best-effort deletion of every remote chat session. |
| `DS_DEBUG` | — | Set to `1`/`true` for verbose SSE/parser debug logging (read lazily in `lib/debug.js`). |
| `DS_DUMP_SSE` | — | Set to `1`/`true` to dump every raw upstream SSE `data:` line plus a path histogram (diagnostic; read lazily in `lib/sse.js`). |

All values are parsed centrally in `lib/config.js`, with two deliberate
exceptions: the diagnostic switches `DS_DEBUG` / `DS_DUMP_SSE` are read lazily
per call (see Architecture).

## Architecture

```
index.js                  process launcher (env guard, auth audit, sweep, signals, concurrency semaphore)
lib/
  server.js               HTTP router, socket hardening, listen/error policy, shutdown wiring
  shutdown.js             graceful-shutdown controller (drain in-flight, close listener)
  config.js               central env parsing (single source of truth)
  handlers.js             per-request handling (CORS, body, session, response)
  health.js               GET /health liveness/readiness report
  recovery.js             empty-retry / continuation / rotation loop (orchestration)
  recovery-markup.js      tool-markup diagnostics + completion/strict-retry passes
  recovery-util.js        shared retry-delay / config helpers for the recovery passes
  upstream-session.js     one completion attempt + expired-session recreation
  upstream.js             DS network layer (uploads, chat, session delete)
  upstream-fetch.js       SSRF guard + size-capped remote file download
  upstream-pow.js         PoW WASM loader + solver (per-URL module cache)
  accounts.js             account pool, round-robin, sticky selection, cooldown
  sessions.js             agent session registry + TTL rollover; deletes the remote session on reset and on shutdown
  sse.js                  DS SSE stream reader
  parser.js               tool-call parser entry point (fenced/inline orchestration)
  json-repair.js          balanced-JSON extraction + repair heuristics
  parser-dsml.js          DSML/XML tag scanning + <invoke> grammar
  parser-limits.js        shared parser size limits
  prompt.js               prompt building + structured screenshot extraction
  openai.js               OpenAI response builders + token estimation
  responses.js            Responses API translation (input/tools <-> internal, output/SSE)
  semaphore.js            idempotent in-flight counter
  uploads.js              MIME guessing, file-id / fetch-files extraction, data URIs
  upload-cache.js         TTL cache for uploaded attachments
  account-status.js       Retry-After parsing (cooldown math)
  recovery-classify.js    response classification (refusal, context-too-long, ...)
  http.js                 HTTP error helpers, CORS/redaction
  debug.js                DS_DEBUG-gated debug logging
  pow.js                  X-DS-PoW-Response header construction
```

`lib/config.js` is the single source of truth for env parsing. Modules read it
lazily via `config.get()`; the exported constants in `sessions.js`/`upstream.js`
are load-time snapshots kept for tests.

The one deliberate exception is the diagnostic switches `DS_DEBUG`
(`lib/debug.js`) and `DS_DUMP_SSE` (`lib/sse.js`), which are read lazily per
call from `process.env` so tests can toggle them via an injected env object.

## Security notes

See [SECURITY.md](SECURITY.md) for the threat model and how to report a
vulnerability privately. The hardening below is what the proxy already does.

- **SSRF guard** (`lib/upstream-fetch.js`): only `http(s)` URLs are fetched; IPv4 and
  IPv6 literals (loopback, RFC1918, link-local, ULA, multicast, IPv4-mapped)
  are blocked, and hostnames are DNS-resolved and every returned address is
  validated. Redirects are followed manually (up to 5 hops) with the full
  check re-run on every hop, and remote downloads are size-capped
  (`DS_MAX_UPLOAD_BYTES`) before the body is buffered.
- **Error redaction** (`lib/http.js` `redactError`): Bearer tokens, cookies,
  JWTs and long base64 blobs are stripped before errors reach logs/CI.
- **Attachment paths** (`lib/prompt.js`): screenshot paths are extracted only
  from structured `tool` result fields, never from free text, so injected
  `MEDIA:` / path strings cannot leak into the model response.
- **Upload cache**: cache keys include a hash of the account token+cookie, so a
  cached `file_id` is never reused after credentials rotate.
- **CORS policy** (`DS_ALLOWED_ORIGINS` + `HOST`): when the allowlist is set,
  only listed origins get an `Access-Control-Allow-Origin` header. When it is
  empty, the request Origin is reflected **only on a loopback bind**; on any
  non-loopback `HOST` no origin is allowed (deny-by-default, anti-CSRF).

  > **⚠ CSRF:** when `HOST` is not loopback and `DS_ALLOWED_ORIGINS` is
  > empty, the proxy **denies all browser origins** (no
  > `Access-Control-Allow-Origin` is emitted), so a web page cannot call the
  > proxy on the user's behalf. On loopback the request Origin is still
  > reflected. To allow specific browser origins on a non-loopback bind, set
  > `DS_ALLOWED_ORIGINS` to an explicit allowlist.
- **`/health` exposure** (`lib/health.js`): unauthenticated. The full report
  (upstream host, account counts, in-flight concurrency) is served only to a
  loopback peer; a non-loopback caller receives just `{ status, shutting_down }`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `All auth accounts are cooling down. Retry in ~Ns` (HTTP 429) | Every account hit a 401/403/429 or a recoverable failure and is parked for `DS_ACCOUNT_COOLDOWN_MS`. | Wait, add another `*.json` account in `DS_AUTH_DIR`, or lower `DS_ACCOUNT_COOLDOWN_MS`. |
| `No valid auth accounts.` (HTTP 503) | `DS_AUTH_DIR` is empty/unreadable, or every config is missing `token`/`cookie`. | Check the startup log — the `DS_AUTH_DIR` audit line plus per-file messages report the cause. Re-run `npm run auth`. |
| `Server busy (N/N requests in flight)` (HTTP 503) | Hit `DS_MAX_CONCURRENT`. | Retry shortly, raise `DS_MAX_CONCURRENT`, or add accounts. |
| HTTP 408 `Request body read timed out` | Body took longer than `DS_BODY_READ_TIMEOUT_MS` to arrive. | Raise the timeout or send a smaller body. |
| HTTP 413 `Request body too large` | Body exceeded `DS_MAX_BODY_BYTES`. | Raise the limit (attachments count toward it). |
| `Server is shutting down.` (HTTP 503) | SIGTERM/SIGINT received; the process is draining. | Wait for restart; in-flight work finishes within `DS_SHUTDOWN_GRACE_MS`. |
| `Skipping auth config …: missing token and cookie` | Auth JSON lacks credentials. | Re-generate with `npm run auth`; the file needs both `token` and `cookie`. |

Set `DS_DEBUG=1` for verbose SSE/parser diagnostics. `npm run start:bg` logs to
`./.run/ds-api-proxy.log` (override with `DS_LOG_FILE`).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, test and style guidelines.

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
