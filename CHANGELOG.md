# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.2] - 2026-08-23

### Changed

- Verification release for the new npm Trusted Publishing / GitHub Actions pipeline — no functional changes.

## [2.2.1] - 2026-08-23

### Added

- `.github/workflows/publish.yml` — publishes to public npm on push of a `@alexdevuwu/logging-v*.*.*` tag, via npm Trusted Publishing (OIDC), no long-lived npm token stored in the repo.

### Changed

- README wording clarified: Seq aggregation is optional and zero-config (one env var), not a required integration.

## [2.2.0] - 2026-08-20

### Added

- `withOperation(name, fields, fn)` — tracks a nested sub-action (a notification send, a payment call, an LLM call — anything whose own outcome is independently meaningful) as its own correlated wide event, safely under concurrency (`AsyncLocalStorage.run`, not `enterWith`). The child event carries `@operation_id` and `@parent_operation_id`, shares the parent's `@request_id`, and is emitted the moment it settles ("Operation completed"/"Operation failed"). The parent event gains a `@child_operations` array (`{ operation_id, name, duration_ms, outcome }` per entry, capped at 50 with `@child_operations_truncated` counting the rest) summarizing every child without needing to open its own line. All new fields — purely additive, no existing field changes shape.
- `startEvent()` and `expressMiddleware` now both mint `@operation_id` — every event has one, root or child, HTTP or not, not just children created by `withOperation`.
- Invalid `outcome` values passed to `endEvent`/`withOperation` (e.g. a typo like `"succes"`) now fall back to `"unknown"` with a one-time stderr warning, instead of being logged verbatim.

### Fixed

- Nested `startEvent()` calls no longer silently corrupt the active event via unscoped `als.enterWith` — they now merge into it and warn once instead of resetting it. (`withOperation` is the sanctioned way to track a nested sub-action; this is a safety net for the mistake, not a second supported pattern.)
- `endEvent()` called from inside a `withOperation` callback no longer risks logging a stale or incorrect outcome — it's now a safe no-op with a one-time warning, so the operation's real outcome (whatever the callback returns or throws) can never be short-circuited.
- `express` was listed as a runtime dependency despite never being imported by `src/` (`expressMiddleware` duck-types `req`/`res`); moved to `devDependencies`. Every install no longer pulls in Express unless you actually use it.

## [2.1.0] - 2026-08-19

### Added

- `outcomeLevels` option on `createLogger` — per-`@outcome` pino level overrides for wide-event emission (e.g. route `client_error` to `warn` instead of the default `info`), merged over new exported defaults `DEFAULT_OUTCOME_LEVELS`. Invalid pino level values are ignored with a one-time stderr warning instead of throwing. Also exports `isFaultOutcome`/`resolveOutcomeLevel` for programmatic access to the resolution logic.

### Changed

- The library's own built-in wide-event messages are now sentence case: `"Request completed"`/`"Request failed"` instead of `"request completed"`/`"request failed"`. Documented as the recommended convention for application messages too.
- `endEvent` and `expressMiddleware` now share one emission path (`emitOutcome` in `src/context.js`) instead of duplicating the outcome→level branching.

## [2.0.0] - 2026-08-19

### Changed

- **BREAKING:** `@outcome` enum redefined — `success | client_error | server_error | error | unknown`. `client_error`/`server_error` are now role-based (request-side fault vs. handler-side fault) and usable from any call site, not just Express middleware — its 5xx case now emits `server_error` instead of `error`. Plain `error` narrows to unclassified failures with no request/response shape. `timeout` removed with no direct replacement; `unknown` added as a fallback for undetermined outcomes.

## [1.0.1] - 2026-08-13

### Changed

- Dummy version

## [1.0.0] - 2026-08-13

### Added

- Wide events — one canonical log line per request per service, enriched throughout lifecycle, emitted once at the end
- Request correlation — automatic `@request_id` generation with `x-request-id` header propagation across services
- AsyncLocalStorage context — enrich the current request's event from anywhere in the call stack without parameter threading
- Dual output — pretty-printed console in development, single-line JSON to stdout in production, and batched Seq ingestion when `SEQ_SERVER_URL` is set
- Secure by default — passwords, tokens, cookies, API keys, and card data are proportionally masked (75% hidden, last 25% shown) before reaching log streams
- Self-describing services — `@service`, `@version`, and `@instance_id` auto-detected from `package.json` and hostname; zero-config for common case
- Uniform message format — every message prefixed with three-letter service tag (e.g., `[BIL] · order created`) for at-a-glance visibility and Seq template grouping
- Environment-based configuration — twelve-factor friendly; explicit options override env vars, env vars override defaults
- Full Seq support — message templates (`@mt`), context dictionaries, batching controls, and all `pino-seq` options pass through
- Framework-agnostic — works in web apps, CLIs, workers, cron jobs, and queue consumers; Express middleware available as optional subpath import
- Graceful shutdown — `flush()` and `close()` guarantee buffered Seq batches are delivered before exit
- Pure ESM, zero test dependencies — `"type": "module"`, no transpilation, tests run on built-in `node:test` runner only
