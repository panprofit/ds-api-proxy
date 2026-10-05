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

Auth configs live in `DS_AUTH_DIR` (default `./.auth`), one `*.json` per account:
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

- `index.js` — process concerns: config wiring, startup auth audit, idle-session
  sweep, signal handling, uncaught-exception policy. Builds the runtime via
  `buildRuntime()`; requiring it must not open a listener or read accounts.
- `lib/config.js` — **the only place that reads `process.env`**. Returns a plain
  object; `config.get()` in request paths, `config.reload()` in tests.
- `lib/server.js` — HTTP router, socket hardening, shutdown controller.
- `lib/handlers.js` — shared request pipeline for both API protocols.
- `lib/openai.js` / `lib/responses.js` — protocol parsing & serialization.
- `lib/recovery.js` — the recovery state machine (empty-retry, continuation,
  markup completion, account rotation). `lib/recovery-markup.js`,
  `lib/recovery-classify.js`, `lib/recovery-util.js` are its helpers.
- `lib/upstream-session.js` — `askDSStream`: one completion attempt with
  session recreation. Injected with all its deps.
- `lib/upstream.js` — DS network layer (`dsFetch`, `dsChatCompletionWithPow`,
  uploads, session create/delete). `lib/upstream-pow.js` solves WASM PoW;
  `lib/pow.js` builds the PoW header; `lib/upstream-fetch.js` is the SSRF guard.
- `lib/accounts.js` — account pool (singleton): LRU selection, sticky per-session
  accounts, cooldowns, hourly cap, **per-account completion throttle**.
- `lib/sessions.js` — session state (singleton). `lib/semaphore.js` — global
  concurrency limiter. `lib/sse.js` — upstream stream reader.
- `lib/parser*.js` — tool-call parsing (DSML, native markers, repair).
- `lib/http.js` — typed errors, status->type mapping, log redaction.

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
