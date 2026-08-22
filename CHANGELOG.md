# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.12] - 2026-08-23

### Fixed

- Release process corrected: GitLab's existing `check_requirements`/`build_and_pack`/`publish_package` pipeline (from the shared `ci-cd/npm` component) owns tag creation on push to `main` — tags must never be created manually, that was the actual cause of pipelines 94–98 failing (`Tag ... already exists`). Releases now: bump version + changelog, push to `main`, let GitLab tag it, then relay that tag to `github` to trigger the npm Trusted Publishing Action.

## [2.2.11] - 2026-08-23

### Changed

- Verification release after recreating the npm Trusted Publisher config with the correct exact-case GitHub org (`AlexDeveloperUwU`) — the prior OIDC token exchange failed with "package not found", likely due to a case mismatch. `publish.yml` debug flags removed.

## [2.2.10] - 2026-08-23

### Changed

- `publish.yml` debug: `--loglevel silly` on the publish step to capture npm's internal OIDC negotiation trace, since stripping the placeholder authToken alone didn't resolve `ENEEDAUTH`.

## [2.2.9] - 2026-08-23

### Fixed

- Root cause found and fixed: `actions/setup-node` always writes a `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` line into the generated `.npmrc`, and npm treats the mere presence of that key — even resolving to an empty value — as "traditional auth configured," so it never falls through to OIDC trusted publishing. `publish.yml` now strips that line before `npm publish`.

## [2.2.8] - 2026-08-23

### Changed

- `publish.yml` debug: dump the generated `.npmrc` and run publish with `--verbose` to see exactly why OIDC still isn't engaging.

## [2.2.7] - 2026-08-23

### Added

- `repository` field in `package.json` pointing at the GitHub repo — required for npm Trusted Publishing to match the publishing workflow to the package; its absence was the actual cause of every prior OIDC failure (npm never attempted the token exchange without it, silently falling through to `ENEEDAUTH`).

## [2.2.6] - 2026-08-23

### Changed

- `publish.yml` adds temporary debug steps (npm version, ID-token env var presence) to diagnose why OIDC trusted publishing isn't engaging despite `permissions: id-token: write`.

## [2.2.5] - 2026-08-23

### Fixed

- `publish.yml` clears `NODE_AUTH_TOKEN` on the publish step — `actions/setup-node` auto-populates it with a placeholder even without an `NPM_TOKEN` secret, which made npm think a traditional token was configured and skip the OIDC trusted-publishing path, still hitting the registry unauthenticated.

## [2.2.4] - 2026-08-23

### Fixed

- `publish.yml` pins Node to `'22'` (latest 22.x) instead of `'22.14'` and npm to `npm@11` instead of `@latest` — `npm@latest` (12.x) requires Node ≥22.22.2 and rejected the pinned runtime with `EBADENGINE`.

## [2.2.3] - 2026-08-23

### Fixed

- `publish.yml` upgrades npm to latest before publishing — the `ubuntu-latest` runner's bundled npm (10.9.2) is older than the 11.5.1 minimum trusted publishing requires, which silently fell back to unauthenticated (404) publish attempts.

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
