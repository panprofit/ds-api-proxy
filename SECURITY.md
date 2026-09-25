# Security Policy

## Scope and threat model

`ds-api-proxy` is a **local proxy for one or a few agents** (e.g. a coding CLI),
not a public multi-tenant gateway. It has **no authentication**, no per-user
quota and no metrics. `DS_MAX_CONCURRENT` is a self-protection cap, not a quota.

The intended deployment is `HOST=127.0.0.1` on a single-user machine. The proxy
holds live DeepSeek credentials (`token` + `cookie` in `DS_AUTH_DIR`), so anyone
who can reach the port can drive those accounts; treat the port as sensitive as
the credentials themselves.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it
privately to the maintainer (open a
[GitHub security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on the repository, or contact the maintainer listed on the repo/profile).

Include: a description, the impact, steps to reproduce, and the affected
version/commit. You can expect an acknowledgement within a few days. Please do
not include real `token`/`cookie` values in a report — redact them.

## Supported versions

This project is pre-1.0 and tracks `master`. Security fixes land on `master`;
there are no maintained release branches. Run the latest `master`.

## Built-in hardening (what is already handled)

- **CORS / CSRF (deny-by-default).** `DS_ALLOWED_ORIGINS` is an explicit origin
  allowlist. When it is empty, an arbitrary request `Origin` is reflected **only
  on a loopback bind**; on any non-loopback `HOST` no browser origin is allowed
  (`lib/config.js` `corsAllowAnyOrigin`, applied in `lib/http.js`
  `applyCorsHeaders`). Keep the default `HOST=127.0.0.1`, or set the allowlist,
  before exposing the proxy.
- **SSRF guard** (`lib/upstream-fetch.js`): only `http(s)` URLs are fetched;
  IPv4/IPv6 literals (loopback, RFC1918, link-local, ULA, multicast,
  IPv4-mapped) are blocked, and hostnames are DNS-resolved with every returned
  address validated. Redirects are followed manually (up to 5 hops) with the
  full check re-run on every hop, and downloads are size-capped
  (`DS_MAX_UPLOAD_BYTES`).
- **Error redaction** (`lib/http.js` `redactError`): bearer tokens, cookies,
  JWTs and long base64 blobs are stripped before errors reach logs/CI.
- **`/health` minimization** (`lib/health.js`): the full readiness report
  (upstream host, account counts, concurrency) is returned **only to a loopback
  peer**; any non-loopback caller gets just `{ status, shutting_down }`.
- **Upload cache keying**: cache keys include a hash of the account
  token+cookie, so a cached `file_id` is never reused after credentials rotate.
- **Attachment paths** (`lib/prompt.js`): screenshot paths are extracted only
  from structured `tool` result fields, never from free text.
- **Non-fatal runtime errors**: after `listen()`, server errors are logged, not
  fatal; startup errors (e.g. `EADDRINUSE`) still exit.

## Operator responsibilities

- **Keep `HOST=127.0.0.1`.** If you must bind wider, set `DS_ALLOWED_ORIGINS`
  to an explicit allowlist and front the proxy with an authenticated gateway.
- **Protect `DS_AUTH_DIR`.** Auth files are written `0600` by `npm run auth`,
  but you are responsible for the directory's permissions and for not
  committing them (`.gitignore` excludes `*.json` there).
- **Never commit `.env` or auth files.** Both are git-ignored; keep it that way.
- **Treat `/health` as diagnostic.** Even minimized, it leaks liveness; do not
  expose it publicly.
- **Rotate accounts** you believe are compromised (re-run `npm run auth`,
  remove the stale file).

## Out of scope

- The upstream DeepSeek service, its availability, or its terms of service.
- Denial of service via resource exhaustion on a machine you already control.
- Anything that requires an attacker to already have local code execution.
