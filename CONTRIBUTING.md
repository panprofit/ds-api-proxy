# Contributing

Thanks for your interest in `ds-api-proxy`. This is a small, dependency-free
Node.js project; the guidelines below keep it that way.

## Requirements

- **Node.js >= 22** (see `.nvmrc`; `nvm use` picks it up). CI also runs Node 24.
- No runtime dependencies. `eslint`, `@eslint/js` and `globals` are the only
  devDependencies — please do not add runtime dependencies without a strong
  reason discussed in an issue first.

## Setup

```bash
npm install          # installs devDeps and installs the pre-commit hook
cp .env.example .env # then edit .env
```

`npm install` runs the `prepare` script, which points `core.hooksPath` at the
committed `.githooks/` directory. Re-install manually with `npm run hooks:install`.

## Before you commit

```bash
npm run check        # node --check on index.js and lib/*.js, then eslint .
npm test             # node --test (the default, deterministic suite)
npm run test:coverage # tests + the coverage gate (used by CI)
```

The **pre-commit hook** auto-fixes staged `*.js` with `eslint --fix` and
re-stages the result, then runs the same `npm run check` gate CI uses. A fixable
nit is corrected; an unfixable lint error blocks the commit.

Formatting is pinned by `.editorconfig` (4-space indent, LF, final newline).

## Tests

- Unit tests live in `test/*.test.js` and run with the built-in `node:test`
  runner — there is no test framework dependency.
- **Performance budgets** are timing assertions and are noisy on shared CI
  runners. They live in `perf/*.perf.js` and run separately via
  **`npm run test:perf`**; `node --test` does not discover `perf/` by default,
  so `npm test` stays deterministic.
- **Add tests with the code.** New modules get a direct `test/<module>.test.js`;
  bug fixes get a regression test that fails without the fix.
- The coverage gate requires **95% lines / 90% functions / 90% branches**
  (`npm run test:coverage`). CI runs it on Node 22 and 24.
- Tests must not reach the network or open real sockets. Inject dependencies
  (`askDSStream`, `readDSResponse`, account/session stubs) as the existing
  suites do.

## Style

- CommonJS (`require`/`module.exports`); the project has no build step.
- Match the surrounding code: 4-space indent, single quotes, semicolons.
- Keep modules focused; `lib/config.js` is the single source of truth for env
  parsing (the diagnostic switches `DS_DEBUG` / `DS_DUMP_SSE` are the only
  deliberate lazy exceptions).
- Comments explain *why*, not *what* — the existing code is the reference.
- Prefer small, reviewable changes; update `README.md` when you change behavior,
  env vars, endpoints or the security posture.

## Commits and PRs

- Write a clear commit subject (`type(scope): summary`, e.g.
  `fix(recovery): ...`) and explain the reasoning in the body when it is not
  obvious. The repository history is a good model.
- One logical change per PR. Include tests and docs.
- CI must be green: syntax check + lint, then tests with the coverage gate.

## Reporting bugs / security

- Bugs and feature requests: open a GitHub issue with a minimal reproduction.
- **Security issues: do not open a public issue** — see [SECURITY.md](SECURITY.md).
