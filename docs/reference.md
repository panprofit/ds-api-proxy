# Reference

Full behaviour, endpoints, environment variables and troubleshooting for
ds-api-proxy. For install/startup see the root [README](../README.md); for the
threat model see [SECURITY.md](SECURITY.md); for contribution workflow see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Endpoints

| Method | Path                     | Description                                  |
|--------|--------------------------|----------------------------------------------|
| POST   | `/v1/chat/completions`   | OpenAI Chat Completions (`stream: true|false`) |
| POST   | `/v1/responses`          | OpenAI Responses API (`stream: true|false`)    |
| GET    | `/v1/models`             | OpenAI model list (informational; any model name is accepted). |
| GET    | `/health`                | Liveness/readiness JSON report (see below).    |

The proxy is meant to run on loopback; `/v1/models` and `/health` are its
only non-completion endpoints. The primary consumer is the pi coding agent, which uses
`/v1/responses` — see [Client integration (pi agent)](#client-integration-pi-agent).

### `GET /health`

Returns a JSON liveness/readiness report. To a **loopback peer** the full
report is: `status` (`ok` / `shutting_down`), `uptime_ms`, an
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

### Structured output and stop sequences

DS has no native equivalents, so two OpenAI request features are downgraded:

- **`response_format`** (Chat Completions) and **`text.format`** (Responses API)
are turned into a system-prompt instruction. `json_object` asks for a bare JSON
object; `json_schema` embeds the schema in a fenced json block. `text` is a
no-op. This is a prompt-level nudge, not enforced grammar.
- **`stop`** (a string or array of strings) is applied locally to the assembled
answer: the response is truncated at the earliest matching sequence. A parsed
tool call is never truncated.
- **`tool_choice`** is a prompt instruction: `none` omits the tool schemas
entirely, `required` and a named `{type:"function", function:{name}}` add a
mandatory-call rule, and `auto` (the default) keeps the normal wording. The
legacy `functions` / `function_call` fields are translated to the current
`tools` / `tool_choice` shape.

### Tool-call parsing

DS does not expose native function calling over its Web API; the proxy prompts
for DeepSeek's own DSML grammar (the V4.1 chat template's `｜DSML｜ calls` block
built from `｜DSML｜ invoke` / `｜DSML｜ parameter name=… string=…` elements; the
space before the tag name is part of the V4.1 format) and parses it back into
OpenAI `tool_calls`. A tool declared with a `namespace` (or a qualified
`namespace::name`) is advertised and invoked in the qualified form. The parser
accepts, in order:

1. **DSML/XML markup** — `｜DSML｜ calls` / `｜DSML｜ invoke` and the
`<invoke>`/`<parameter>` grammar (the format the prompt asks for).
2. **Strict / fenced JSON** — `{"tool_call":{"name","arguments"}}` inline or in
a ```json fence (with the usual JSON repair heuristics for truncated or
mis-escaped output); kept as a fallback for older upstream behavior.
3. **Native markers** — DS's older `<|tool▁calls▁begin|> … <|tool▁calls▁end|>`
grammar wrapping a bare `[{"name","arguments"}]` array. Marker matching is
*fuzzy*: the fullwidth pipe `｜` (U+FF5C) is treated as `|` and the separator
`▁` (U+2581) as `_`, so a hallucinated `</|tool_calls▁end｜>` still closes the
block.

A tool call inside a markdown code fence is ignored (it is an illustration,
not a request), except for a lone ```sh/```bash fence, which is treated as a
`bash` call. Tag names quoted in inline code (`` `<tool_calls>` `` in a prose
explanation of the format) are likewise ignored rather than mistaken for
truncated markup.

If the parsed call names a tool that is **not** in the request's `tools` list,
the proxy does **not** treat it as broken markup (the JSON was valid — the model
just hallucinated a name). It records the name and rotates to another account,
since a hallucinated name is deterministic for that account+session. If no
account is available, the request ends with a terminal `502 unknown_tool` error
rather than returning the raw `{"tool_call":…}` markup as assistant text (which
would strand the consuming agent).

### Streaming `obfuscation`

When the client sends `stream_options.include_obfuscation: true`, every
choice-bearing SSE chunk carries a random base64 `obfuscation` field (top-level,
not inside `delta`) so the serialized chunk is ~512 characters — OpenAI's
side-channel mitigation. Usage-only and terminal chunks carry no padding.

### `/v1/responses` notes

- **Request.** The conversation is passed via `input` (a string, or an array of
  items: `message`, `function_call`, `function_call_output`); `instructions`
  becomes the system prompt. `tools` use the flat Responses shape
  (`{type:"function", name, description, parameters}`) and are normalized
  internally. `stream` and `stream_options.include_usage` are honored.
  `system` messages after the first non-system turn are kept in place as V4.1
  mid-conversation system turns; leading ones form the system prompt.
  `reasoning` items are re-attached to the following assistant turn as
  `reasoning_content`. Prior-turn reasoning is re-rendered only when the request
  declares `tools` (V4.1 disables `drop_thinking` for tool-calling); without
  tools, reasoning from turns before the latest `user` message is dropped, while
  reasoning inside the current turn survives across tool results.
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
remote address. Use `x-agent-session` to pin a conversation to a specific
upstream session; change it to start a fresh one.

### Anonymous (ephemeral) mode

A request with **no** session identifier at all is served in *anonymous* mode
(a unique UUID key). `DS_IGNORE_AGENT_SESSION=1` forces this mode for
**every** request, even when the agent does send an identifier — the headers
above are ignored outright.

Anonymous mode is **stateless on the upstream side**:

- Each request is its own remote conversation. A fresh DS chat session is
  created and the **full prompt** (all `messages`, the system prompt, tools)
  is sent on every turn — nothing is reused from the previous turn.
- The remote session is deleted as soon as the response is written (the
  upstream delete is fire-and-forget, so it never delays the reply), and the
  local session record is dropped.
- Account selection is **LRU-only**: the request skips the sticky-account
  fast-path and is spread across the pool, so no single account accumulates a
  long-lived conversation.

In the **non-anonymous** (named-session) mode the proxy keeps one sticky DS chat
per session id and forwards only the *new* turns: it reuses the existing remote
session, sends the delta since the last request, and keeps the `parentMessageId`
thread. That is cheaper (less re-sent history) and preserves upstream context,
but it is stateful — an idle session is rolled over after `DS_SESSION_TTL_MS`,
and a shrink of the `messages` array (e.g. a `/compact` summary) resets the
remote session immediately. Use anonymous mode for one-shot or fully stateless
clients; use a named session when continuity matters.

### Account selection and rotation

Accounts are loaded from `DS_AUTH_DIR` and selected per session:

1. **Sticky** — a session keeps the account it is already bound to while that
   account stays healthy (credentials present, not cooling down).
2. **Least-recently-used** — otherwise the ready account with the oldest
   `lastUsedAt` is picked, spreading load evenly without a shared cursor.

An account becomes unavailable (parked) when it hits any of these, after which
requests rotate to another account:

- an HTTP **401/403/429** failure — parked for `DS_ACCOUNT_COOLDOWN_MS` (or the
  upstream `Retry-After`, whichever is longer);
- a **recoverable failure** (malformed tool markup, empty response, unknown
  tool name) — rotated immediately, without parking the account. With exactly
  one configured account, an empty or reasoning-only response first gets
  `DS_MAX_SAME_ACCOUNT_RETRIES` attempt(s) in a fresh remote session instead of
  ending the request immediately;

A transient upstream outage (`finish_reason=generation_err`) is not the account's
fault: the same account is retried in place (`DS_MAX_UPSTREAM_RETRIES`) and only
then recreated once in a fresh session. When such an error arrives after
tool-intent reasoning on a thinking request that carries tools, DS is aborting
the turn exactly as it starts emitting the tool call; the proxy spends one extra
attempt with thinking disabled before entering that retry path.

When every account is parked the request returns HTTP 429 with a
`retry_in`-style hint until the earliest window opens.

Cooldown deadlines and the LRU `lastUsedAt` are persisted to
`$DS_AUTH_DIR/.account-state.json` and restored on startup, so restarting the
proxy neither re-hits an account that is still parked (e.g. a DS mute that lasts
hours or days) nor resets rotation back to the first loaded account. Expired
cooldowns are dropped on load and on write; `lastUsedAt` keeps its relative
ordering. Because writes are periodic, an abrupt crash can lose up to
`DS_ACCOUNT_STATE_FLUSH_MS` of state.


## Environment variables

| Variable                             | Default                     | Description                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                               | `9876`                      | HTTP listen port (1–65535).                                                                                                                                                                                                                                        |
| `HOST`                               | `127.0.0.1`                 | HTTP listen host. **On a non-loopback bind with an empty `DS_ALLOWED_ORIGINS`, CORS denies all browser origins (anti-CSRF); set the allowlist to permit specific origins.**                                                                                        |
| `DS_AUTH_DIR`                        | `./.auth`                 | Directory scanned for `*.json` auth configs (sorted). Defaults to `./.auth`; when the directory is missing or holds no valid configs, no accounts load and every completion returns 503. Audited at startup (missing dir, no `*.json` files, or none loading all produce a clear log line).                 |
| `DS_ACCOUNT_COOLDOWN_MS`             | `300000` (5 min)            | Cooldown after an HTTP 401/403/429 account failure.                                                                                                                                                                                                                |
| `DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS` | `6000`                    | Minimum spacing (ms) between consecutive completions on the same account, so a burst spreads across the pool instead of hammering one account. `0` disables the throttle.                                                                                            |
| `DS_TOKEN_REFRESH_INTERVAL_MS`       | `3000000` (50 min)          | At most once per interval, refresh an account's bearer token via `GET /api/v0/users/current` for subsequent calls (DS rotates web tokens hourly). For email-keyed accounts the rotated token is written back to the auth file; legacy token+cookie-keyed files are updated in memory only. `0` disables the refresh.                                                |
| `DS_ACCOUNT_STATE_FLUSH_MS`          | `60000`                     | How often (ms) the persisted per-account runtime state (`$DS_AUTH_DIR/.account-state.json`: cooldowns, LRU) is flushed to disk. `0` disables persistence.                                                                                          |
| `DS_CLIENT_LOCALE`                   | `en`                        | Default `x-client-locale` sent upstream; per-account `locale` overrides it.                                                                                                                                                                                        |
| `DS_CLIENT_TIMEZONE_OFFSET`          | `0`                         | Default `x-client-timezone-offset` sent upstream; per-account `timezone_offset` overrides it.                                                                                                                                                                      |
| `DS_MAX_CONCURRENT`                  | `10`                        | Max simultaneous in-flight completions.                                                                                                                                                                                                                            |
| `DS_REQUEST_DEADLINE_MS`             | `120000`                    | Per-request deadline before recovery gives up.                                                                                                                                                                                                                     |
| `DS_ROTATION_BUDGET_MS`              | `60000`                     | Wall-clock budget for cycling through accounts after failures, so a request does not spend its whole deadline waiting out cooldowns on every account.                                                                                                               |
| `DS_MAX_UPSTREAM_RETRIES`            | `3`                         | Same-account retries when DS itself reports a transient outage (`finish_reason=generation_err` / "Server temporarily unavailable."). Rotating accounts cannot help here (all share the same upstream), so the current account is retried instead of parked (0–10). |
| `DS_MAX_SAME_ACCOUNT_RETRIES`        | `1`                         | Same-account retries for a recoverable empty / reasoning-only response when exactly one account is configured. The retry uses a fresh remote session and does not consume the multi-account rotation budget (0–10). |
| `DS_MAX_CONTINUATION`                | `2`                         | Max auto-continuation rounds for long/length-finished responses (0–10).                                                                                                                                                                                            |
| `DS_ACTION_PROMISE_MAX_CHARS`        | `600`                       | Max content length (chars) for the action-promise phase: a longer body is a real answer, not a promise to act.                                                                                                                                                     |
| `DS_TOKEN_RATE_LIMIT_PER_MIN`        | `0` (off)                   | Adaptive completion throttle by burn rate. Above this tokens/min the interval between completions on one account is stretched, so a long continuation burst self-spaces instead of tripping the upstream 429. `0` disables the adaptive part (the fixed `DS_ACCOUNT_MIN_COMPLETION_INTERVAL_MS` still applies).                                                                    |
| `DS_TOKEN_RATE_BACKOFF_FACTOR`       | `2`                         | Extra intervals a fully pressured session (burn ≥ 2× the limit above) waits; the stretch scales linearly from 0 at the limit to this factor. `0` disables it (0–10).                                                                                                                                                                     |
| `DS_CONTINUATION_SIZE_THRESHOLD`     | `25000`                     | Response length (chars) above which auto-continuation kicks in.                                                                                                                                                                                                    |
| `DS_MAX_RESPONSE_WORDS`              | `500`                       | Max response length in words, injected as a system-prompt instruction so the model keeps answers short. `0` disables the instruction.                                                                                                                              |
| `DS_RECOVERY_RETRY_DELAY_MS`         | `500`                       | Base delay between recovery retries (scaled, capped at 3×).                                                                                                                                                                                                        |
| `DS_IGNORE_AGENT_SESSION`           | `0` (off)                  | When set to `1`, force every request into the ephemeral anonymous mode: all session-id headers/body fields are ignored and each call gets a unique throwaway session, even from agents that do send an identifier. Off by default, so session headers are honored. |                                                                                                                               |
| `DS_SESSION_TTL_MS`                  | `7200000` (2 h)             | Idle TTL: a remote session is rolled over only after this long without conversation activity. An actively-used session is never reset on age alone. Independently, a shorter `messages` array than the previous request (a `/compact` summary replacing the history) resets the remote session immediately. |
| `DS_MAX_SESSIONS`                    | `1000`                      | Max concurrent agent sessions.                                                                                                                                                                                                                                     |
| `DS_SESSION_SWEEP_INTERVAL_MS`       | `600000` (10 min)           | Interval between idle-session / stale-upload sweeps.                                                                                                                                                                                                               |
| `DS_UPLOAD_CACHE_TTL_MS`             | `21600000` (6 h)            | Upload cache TTL.                                                                                                                                                                                                                                                  |
| `DS_MAX_UPLOAD_BYTES`                | `26214400` (25 MB)          | Max size of a single uploaded attachment.                                                                                                                                                                                                                          |
| `DS_MAX_BODY_BYTES`                  | `10485760` (10 MB)          | Max size of an incoming request body.                                                                                                                                                                                                                              |
| `DS_MAX_TOOL_RESULT_BYTES`           | `65536` (64 KB)             | Max size of one tool result before it enters the upstream prompt. Larger results are truncated on a UTF-8 boundary with a marker. `0` disables truncation.                                                                                                         |
| `DS_BODY_READ_TIMEOUT_MS`            | `30000`                     | Max time to receive a full body before `408`.                                                                                                                                                                                                                      |
| `DS_HEADERS_TIMEOUT_MS`              | `60000`                     | Socket cap on sending request headers.                                                                                                                                                                                                                             |
| `DS_REQUEST_TIMEOUT_MS`              | `300000`                    | Socket cap on the whole request.                                                                                                                                                                                                                                   |
| `DS_FETCH_TIMEOUT_MS`                | `60000`                     | Timeout for ancillary DS fetch calls (PoW challenge, session create/delete, uploads). The completion stream is bounded by `DS_REQUEST_DEADLINE_MS` instead, so a long answer is not aborted mid-stream.                                                              |
| `DS_FILE_POLL_INTERVAL_MS`           | `1000`                      | Interval when polling uploaded file status.                                                                                                                                                                                                                        |
| `DS_FILE_POLL_TIMEOUT_MS`            | `60000`                     | Timeout waiting for an uploaded file to become `SUCCESS`.                                                                                                                                                                                                          |
| `DS_ALLOWED_ORIGINS`                 | —                           | Comma-separated CORS origin allowlist. When empty, the request Origin is reflected only on a loopback `HOST`; on a non-loopback bind no browser origin is allowed (deny-by-default).                                                                               |
| `DS_STREAM_KEEPALIVE_MS`             | `15000`                     | SSE keep-alive interval in ms; `0` disables.                                                                                                                                                                                                                       |
| `DS_DEFAULT_SEARCH_ENABLED`          | `1`                         | Upstream `search_enabled` default when the client does not send `web_search_options`. `0` gives strict OpenAI semantics (absent == off); an explicit `web_search_options` always forces search on.                                                                  |
| `DS_SHUTDOWN_GRACE_MS`               | `15000`                     | Grace period for draining in-flight requests on SIGTERM/SIGINT, and for the final best-effort deletion of every remote chat session.                                                                                                                               |
| `DS_DEBUG`                           | —                           | Set to `1`/`true` for verbose SSE/parser debug logging (read lazily in `lib/debug.js`).                                                                                                                                                                            |
| `DS_DUMP_SSE`                        | —                           | Set to `1`/`true` to dump every raw upstream SSE `data:` line plus a path histogram (diagnostic; read lazily in `lib/sse.js`).                                                                                                                                     |

All values are parsed centrally in `lib/config.js`, with two deliberate
exceptions: the diagnostic switches `DS_DEBUG` / `DS_DUMP_SSE` are read lazily
per call (see [AGENTS.md -> Architecture](AGENTS.md#architecture)). The
auth-helper and process-management scripts
read their own variables (see below).

### Auth helper (`npm run auth`)

Read by `scripts/auth.js` (via `lib/config.js`). Only needed for the one-shot
login helper.

| Variable                        | Default  | Description                                                                                          |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `CHROME_PATH`                   | —        | Path to a local Chrome/Chromium binary when it is not on a standard path.                            |
| `DS_AUTH_CDP_PORT`              | `9339`   | Chrome DevTools Protocol port used to drive the disposable profile (1–65535).                        |
| `DS_LOGIN_FORM_TIMEOUT_MS`      | `30000`  | How long to wait for the login form to appear.                                                       |
| `DS_LOGIN_TIMEOUT_MS`           | `120000` | Overall login timeout.                                                                               |
| `DS_KEEP_PROFILE`               | `false`  | Set to `1` to keep the temporary Chrome profile after the run (debugging).                           |

### Process management (`scripts/start.sh`, `scripts/stop.sh`)

| Variable       | Default                   | Description                                                    |
| -------------- | ------------------------- | -------------------------------------------------------------- |
| `DS_PID_FILE`  | `./.run/.pid` | PID file written by `start.sh` / read by `stop.sh`.            |
| `DS_LOG_FILE`  | `./.run/.log` | Log file the background server appends to (`npm run start:bg`). Restarts do not truncate it. |

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
- **Upload cache**: cache keys include the account id (email hash) plus a content
  hash, so a cached `file_id` is never reused for a different account while a
  token refresh does not evict it. When recovery switches accounts, the images
  in the full history are re-uploaded under the new account, because its fresh
  remote session cannot use the previous account's file ids.
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
| `All auth accounts are cooling down. Retry in ~Ns` (HTTP 429) | Every account hit a 401/403/429 or a recoverable failure (`DS_ACCOUNT_COOLDOWN_MS`), so none is available. | Wait, add another `*.json` account in `DS_AUTH_DIR`, or lower `DS_ACCOUNT_COOLDOWN_MS`. |
| `No valid auth accounts.` (HTTP 503) | `DS_AUTH_DIR` is empty/unreadable, or every config is missing `token`/`cookie`. | Check the startup log — the `DS_AUTH_DIR` audit line plus per-file messages report the cause. Re-run `npm run auth`. |
| `Server busy (N/N requests in flight)` (HTTP 503) | Hit `DS_MAX_CONCURRENT`. | Retry shortly, raise `DS_MAX_CONCURRENT`, or add accounts. |
| HTTP 408 `Request body read timed out` | Body took longer than `DS_BODY_READ_TIMEOUT_MS` to arrive. | Raise the timeout or send a smaller body. |
| HTTP 413 `Request body too large` | Body exceeded `DS_MAX_BODY_BYTES`. | Raise the limit (attachments count toward it). |
| `Server is shutting down.` (HTTP 503) | SIGTERM/SIGINT received; the process is draining. | Wait for restart; in-flight work finishes within `DS_SHUTDOWN_GRACE_MS`. |
| `Skipping auth config …: missing token and cookie` | Auth JSON lacks credentials. | Re-generate with `npm run auth`; the file needs both `token` and `cookie`. |

Set `DS_DEBUG=1` for verbose SSE/parser diagnostics. `npm run start:bg` appends
to `./.run/.log` (override with `DS_LOG_FILE`); the file is never
truncated on restart.

