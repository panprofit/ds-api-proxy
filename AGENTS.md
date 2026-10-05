# AGENTS.md

Operational guide for AI agents working in this repository. This is a cheat
sheet, not an essay: keep it short, precise and up to date.

## Project

OpenAI-compatible proxy for the DeepSeek web chat API. Adds PoW solving,
multi-account rotation, tool-call parsing/repair and recovery on top of DS's
private Web API, exposing `/v1/chat/completions` and `/v1/responses`.

- Runtime: **Node >= 22**, **CommonJS**, every file starts with `'use strict';`.
- Zero runtime dependencies. Dev-only: eslint, typescript (for `tsc` checking).
- Entry point: `index.js` (process/lifecycle wiring) -> `lib/server.js` (router).

## Setup

```bash
cp .env.example .env        # then set DS_AUTH_DIR
npm install                 # dev deps only
npm run auth                # writes *.json auth configs into DS_AUTH_DIR
```

Auth configs live in `DS_AUTH_DIR` (no default; when unset, no accounts load and every request returns 503), one `*.json` per account:
`{ "token": "...", "cookie": "...", "wasmUrl": "..." }`. Never commit them.

## Commands

```bash
npm test                    # all tests (node --test)
npm test -- --test-name-pattern="throttle"   # run a subset
npm run lint                # eslint .
npm run typecheck           # tsc -p jsconfig.json
npm run check               # node --check + eslint + tsc (what pre-commit runs)
npm start                   # run the proxy
```

`node --test` discovers `test/*.test.js`. There is no watch/coverage requirement
in normal work; `npm run test:coverage` exists but is strict (95% lines).

## Architecture

`index.js` sits at the root; every other module lives in `lib/`.

| Module | Role |
| --- | --- |
| `index.js` | process launcher (env guard, auth audit, sweep, signals, concurrency semaphore) |
| `lib/server.js` | HTTP router, socket hardening, listen/error policy, shutdown wiring |
| `lib/shutdown.js` | graceful-shutdown controller (drain in-flight, close listener) |
| `lib/config.js` | central env parsing (single source of truth) |
| `lib/handlers.js` | per-request handling (CORS, body, session, response) |
| `lib/health.js` | `GET /health` liveness/readiness report |
| `lib/metrics.js` | in-flight / lifetime counters, surfaced via `/health` |
| `lib/recovery.js` | recovery state machine (empty-retry / reasoning-only / upstream-transient / auto-continuation / markup / rotation phases) |
| `lib/recovery-markup.js` | tool-markup diagnostics + completion/strict-retry passes |
| `lib/recovery-util.js` | shared retry-delay / config helpers for the recovery passes |
| `lib/recovery-classify.js` | response classification (refusal, context-too-long, ...) |
| `lib/upstream-session.js` | one completion attempt + expired-session recreation |
| `lib/upstream.js` | DS network layer (uploads, chat, session delete) |
| `lib/upstream-fetch.js` | SSRF guard + size-capped remote file download |
| `lib/upstream-pow.js` | PoW WASM loader + solver (per-URL module cache) |
| `lib/accounts.js` | account pool, LRU selection, sticky selection, cooldown, per-account completion throttle |
| `lib/sessions.js` | agent session registry + TTL rollover; deletes the remote session on reset and on shutdown |
| `lib/sse.js` | DS SSE stream reader |
| `lib/parser.js` | tool-call parser entry point (fenced/inline orchestration) |
| `lib/json-repair.js` | balanced-JSON extraction + repair heuristics |
| `lib/parser-dsml.js` | DSML/XML tag scanning + `<invoke>` grammar |
| `lib/parser-native.js` | native `<|tool▁calls▁begin|>`...`<|tool▁calls▁end|>` marker grammar (fuzzy `|`/`｜` and `_`/`▁` matching) |
| `lib/parser-limits.js` | shared parser size limits |
| `lib/prompt.js` | prompt building + structured screenshot extraction |
| `lib/openai.js` | OpenAI response builders + token estimation |
| `lib/responses.js` | Responses API translation (input/tools <-> internal, output/SSE) |
| `lib/semaphore.js` | idempotent in-flight counter |
| `lib/uploads.js` | MIME guessing, file-id / fetch-files extraction, data URIs |
| `lib/upload-cache.js` | TTL cache for uploaded attachments |
| `lib/account-status.js` | Retry-After parsing (cooldown math) |
| `lib/http.js` | HTTP error helpers, CORS/redaction |
| `lib/debug.js` | `DS_DEBUG`-gated debug logging |
| `lib/pow.js` | `X-DS-PoW-Response` header construction |

This list is the **complete** module map and the single source of truth for
"what lives where". [README.md](README.md) links here. Keep it in sync when
adding, renaming or removing a module.

`lib/config.js` is the single source of truth for env parsing. Modules read it
lazily via `config.get()`; the exported constants in `sessions.js`/`upstream.js`
are load-time snapshots kept for tests. The one deliberate exception is the
diagnostic switches `DS_DEBUG` (`lib/debug.js`) and `DS_DUMP_SSE` (`lib/sse.js`),
which are read lazily per call from `process.env` so tests can toggle them via an
injected env object.

Data flow: request -> `handlers.runCompletionPipeline` -> `runWithRecovery` ->
`askDSStream` -> `dsChatCompletionWithPow` -> DS -> `readDSResponse` -> result.

## Conventions

- **All env parsing lives in `lib/config.js`.** Do not read `process.env`
  anywhere else, including tests (except `server-env.test.js`, which spawns a
  child process).
- **Request-path code reads config via `config.get()` at call time.** Exported
  load-time snapshot constants (e.g. `upstream.DS_FETCH_TIMEOUT_MS`) exist only
  for tests/back-compat and do NOT track `reload()`.
- Modules are singletons where noted (`accounts`, `sessions`); tests must
  snapshot/restore their mutable arrays rather than re-require the module graph.
- Comments explain *why*, not *what*. Match the surrounding density: this repo
  is heavily commented on purpose.
- Keep public exports stable; if you remove one, remove its tests and the
  `module.exports` entry in the same change.

## Testing

- Framework: `node:test` + `node:assert/strict`. No network, no HTTP server in
  unit tests — inject fakes (`askDSStream`, `readDSResponse`, `dsFetch`, ...).
- Change config in tests **only** via `config.reload({ ... })`; never assign to
  `process.env`. A throwing test must not leak overrides into the next one.
- Restore singleton state in `afterEach` (see `test/accounts.test.js`).
- Time/delay-sensitive code takes injectable `sleep`/`now` (or a `sleep` dep) so
  tests are deterministic and fast — use that seam instead of real timers.
- Add tests with every behavior change. If a test asserted a symbol you deleted,
  delete/update that test rather than leaving it green-but-meaningless.

## Critical invariants (do not break)

- **PoW is time/nonce-bound.** `X-DS-PoW-Response` must be solved immediately
  before the request goes out. Any wait (e.g. the completion throttle) must
  happen BEFORE `solvePowForPath`, never after.
- Every upstream call goes through `dsFetch`. Only completions pass
  `quotaAccount` (that is what counts against the hourly cap); ancillary calls
  (PoW, session create/delete, uploads, fetch_files) must NOT.
- Long waits must honor `deadlineHit()` and `clientGone()`; otherwise an aborted
  client holds resources until `fetchTimeoutMs`.
- Errors crossing the recovery boundary must be typed via `createTypedError` /
  `createUpstreamHttpError` (`lib/http.js`) so classification and rotation work.

## Do / Don't

- DO run `npm test` and `npm run check` before declaring work done.
- DO add an env variable to `lib/config.js`, `.env.example`, `test/config.test.js`.
- DON'T commit auth configs, `.env`, or anything under `DS_AUTH_DIR`.
- DON'T edit `node_modules` or generated output.
- DON'T reach into another module's mutable state directly; use its exports.
- DON'T leave dead code; if something is unreferenced, delete it and its test.

## Git

- **Conventional Commits**: `feat(scope): ...`, `refactor(scope): ...`,
  `test(...)`, `fix(...)`, `docs(...)`.
- A **pre-commit hook** runs `eslint --fix` on staged `*.js` then `npm run check`.
  Fix failures rather than bypassing with `--no-verify`.
- Keep commits focused; a behavior change ships with its tests in the same commit.

## Environment notes

- Node 22+ is required (`--env-file-if-exists` is used by the start scripts).
- `npm run auth` needs a real browser (AWS WAF JS challenge); set `CHROME_PATH`
  if Chrome/Chromium is not in a standard location.
- See `.env.example` for every tunable and its default.
