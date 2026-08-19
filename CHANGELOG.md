# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
