# CLAUDE.md

Guidelines for AI assistants (and humans) working in this repository.

## Project overview

`@alexdevuwu.logging` (published as `@alexdevuwu/logging`) is an opinionated structured-logging library for Node.js: a thin, pure-ESM JavaScript wrapper over **pino**, with **pino-pretty** for development output and **pino-seq** for Seq aggregation.

The wide-events philosophy — one context-rich canonical log line per request per service, per [loggingsucks.com](https://loggingsucks.com/) — is the _point_ of the library, not a feature. Every design decision should be checked against it: does this make the single wide event richer, emission more reliable, or querying more powerful? If not, it probably doesn't belong here.

Two signature behaviors define the library's output and must keep working in every change:

- **Auto-detection**: service name, version, and instance ID resolve automatically (options → env vars → `package.json` / `os.hostname()` → `'unknown'`). Zero-config is the common case; nothing throws for missing context.
- **Message tag**: every message is prefixed `[APP] · ` — first three letters of the service name, uppercased, `*`-padded (`AP*`, `A**`), `UNK` when unknown. Constant per service, so Seq template grouping is unaffected.
- **`@`-prefixed metadata**: all library-injected fields use the `@` prefix (`@service`, `@request_id`, `@duration_ms`, etc.) to stay visually distinct from application fields. This follows Seq's own `@mt`/`@x` convention.

## Commands

```bash
npm test                 # node --test "test/*.test.js"  (built-in runner, zero test deps)
npm run test:watch       # node --test --watch "test/*.test.js"
npm run lint             # eslint (flat config)
npm run format           # prettier --write .
npm run example:basic    # smoke-run examples/basic.js
npm run example:express  # smoke-run examples/express.js (needs express installed)
```

There is no build step. `src/` is what ships.

## Repository structure

```
├── package.json            # type: module; exports: "." and "./express"; files: src/
├── src/
│   ├── index.js            # public barrel — re-exports the whole public API
│   ├── config.js           # resolveConfig(options, env) — pure, returns frozen config
│   ├── logger.js           # createLogger / initLogger / getLogger / flush / close
│   ├── context.js          # AsyncLocalStorage + wide-event lifecycle (startEvent/enrichEvent/endEvent/withContext); deep-merge
│   ├── streams.js          # pino.multistream assembly: pretty / JSON stdout / pino-seq
│   ├── redaction.js        # DEFAULT_REDACT_PATHS + user-path merging + the compiled deep-redaction walker (createRedactor)
│   ├── serializers.js      # err/error serializers → { type, message, code, stack, cause? }
│   └── middleware/express.js  # expressMiddleware(logger) — one wide event per request
├── test/                   # one .test.js per src module
└── examples/               # runnable usage demos (basic, wide-event, express, shutdown)
```

## Coding standards

- **Pure ESM JavaScript.** `import`/`export` only. No TypeScript syntax, no type annotations, no `.d.ts`, no compilation. `"type": "module"` is permanent.
- **JSDoc on every public export** — `@param` and `@returns` at minimum. This is the API documentation.
- **Naming:** camelCase for JS identifiers (variables, functions, options), but **snake_case for all log field names** (`request_id`, `duration_ms`, `user_id`). This split is deliberate and is the #1 source of confusion in this codebase — log fields are a cross-service schema, code style is not.
- **`@`-prefixed metadata fields:** library-injected fields carry the `@` prefix (`@service`, `@request_id`, `@outcome`, `@duration_ms`, `@error`, etc.) to namespace them from application fields. Application fields never use `@`. The `@` convention matches Seq's own metadata pattern (`@mt`, `@x`, `@l`).
- **Message prefix and redaction both live in pino's `hooks.logMethod`** (rewrite the string argument, then replace object args with redacted clones; never mutate the merging object in place). Do not try to do it in `formatters.log` — `msg` is not reliably visible there. Never bypass the hook by writing to destinations directly.
- **Redaction is the library's own compiled walker (`createRedactor`), not pino's `redact` option.** pino's path-list redact is O(paths × depth) per top-level key and its `*.name` wildcard matches only one level — both wrong for this library. The walker matches keys at **any** depth, honors exact chains (`headers.authorization`, `headers["x-api-key"]`) and mid-chain `*`, never mutates inputs, and returns the same reference (zero copy) when nothing matches. Keep it that way — `logger.js` must keep passing the redactor through the hook, and must not reintroduce pino's `redact` option.
- **Redaction censor is a function** implementing the 75/25 rule: values shorter than 3 chars → `***`; otherwise mask all but the **last** 25% with `*`. Keep it deterministic, total (any input type → string), and allocation-cheap — it runs per matched field, per event. User censors receive `(value, path)` where `path` is the key chain array.
- **`redactRemove` removes a name and every variant of it** (leaf-name match): `redactRemove: ["token"]` drops `token`, `*.token`, and any `headers.*` entry whose leaf is `token`.
- **Async/await** everywhere; no callback-style async, no raw `.then` chains in new code.
- **Node >= 18 APIs only** (`crypto.randomUUID()`, `AsyncLocalStorage`, `node:test`). Recommend >= 20 in docs.
- Formatting is Prettier's job; linting is ESLint's job (flat config, no stylistic rules — leave style to Prettier). Both are dev-only tooling and never touch shipped output.

## Testing conventions

- **`node:test` + `node:assert/strict` only.** No jest, vitest, mocha, supertest, or assertion libraries.
- One test file per source module: `test/config.test.js` tests `src/config.js`, etc.
- **The test seam is `createLogger({ destination })`** — inject a synchronous in-memory `Writable` that collects parsed JSON lines. Every behavioral assertion goes through it.
- Tests **never** touch stdout, the network, or a live Seq server. Express middleware is tested with stub `req`/`res` objects (`EventEmitter`-based `res`).
- The critical test: two interleaved `withContext` async tasks must never cross-contaminate their events (AsyncLocalStorage isolation).

## Architectural guardrails — NEVER list

- **NEVER add CommonJS** — no `require`, no `module.exports`, no dual-package exports. ESM only.
- **NEVER use `pino.transport()` with pino-seq.** pino-seq@4 has no worker-thread transport; it is an in-process `Writable` from `createStream()`. All multi-destination output goes through `pino.multistream`.
- **NEVER bypass the redaction layer.** New log sites must pass user-provided objects through the configured serializers/redaction. Widening redaction is always safe; removing a default path requires the deliberate `redactRemove` opt-out.
- **NEVER emit more than one log line per request in middleware.** Handlers enrich the wide event; the middleware emits it once, at the end, in a `finally`/`finish` path.
- **NEVER add a runtime dependency** without documenting the justification in this file. The runtime dependency list is: `pino`, `pino-seq`. (`pino-pretty` is an optional peer.)
- **NEVER log inside `onError` handlers** (Seq delivery failures) — that's a recursion risk. Write to `process.stderr` only.
- **NEVER auto-initialize a global logger from env alone.** `createLogger` is explicit; `getLogger()` must throw if `initLogger()` was never called. The only module-level mutable state is the documented `initLogger` memo (with a reset seam for tests).
- **NEVER add an env var** without, in the same change: parsing + validation in `src/config.js`, and a row in the README's env-var table.
- **NEVER let `createLogger` become async.** pino-pretty is loaded synchronously via `createRequire(import.meta.url)` when pretty output is enabled; if it's absent, warn once on stderr and fall back to JSON.
- **NEVER couple the core to a web framework.** Not every consumer is a web app — `src/` outside `middleware/` must not import or assume Express/HTTP types; req/res handling is duck-typed and confined to `src/middleware/express.js`.
- **NEVER throw for missing configuration that has a fallback.** Auto-detection (package.json, hostname) ends at `'unknown'`/`[UNK]` plus one stderr warning. Exceptions are reserved for programmer errors (e.g. invalid option types).
- **NEVER hide or re-wrap pino-seq / seq-logging options.** Full passthrough (message templating, `additionalProperties` context dictionaries, `logOtherAs`, batching limits) is a feature; the `seq` object goes to `createStream` with only documented defaults applied.

## Key external facts (don't re-derive)

- **pino-seq@4** is ESM-only; exports `createStream(config) → PinoSeqStream` (a `Writable`). Config: `serverUrl`, `apiKey`, `maxBatchingTime`, `eventSizeLimit`, `batchSizeLimit`, `onError`, `additionalProperties`, `logOtherAs`. There is **no `batchSize` option**.
- pino-seq level mapping: 10→Verbose, 20→Debug, 30→Information, 40→Warning, 50→Error, 60→Fatal. `msg` → Seq message template (`@mt`); `err`/`error` → Seq exception (`@x`) with remaining props merged.
- pino-seq **batches**; `await stream.flush()` is required before exit or buffered events are silently lost. `close()` in `logger.js` owns this.
- pino-seq peer-depends on **pino v10** — keep `pino: ^10` and verify `npm ls pino` resolves a single copy.
- String-interpolated messages destroy Seq's template grouping (`@mt`). The library deliberately offers no sprintf-style API.
- The `[APP] · ` message tag is implemented in `hooks.logMethod(args, method, level)`: find the first string argument, prefix it, then `method.apply(this, args)`. The tag derives from the resolved service name (3 chars, uppercase, `*`-padded, `UNK` fallback) and is computed once at `createLogger` time. The same hook deep-redacts every object arg (merging object **and** `%j`/`%o` interpolation args).
- The 75/25 proportional mask is `defaultCensor(value)`, invoked by the redaction walker (and by pino-compatible `buildRedact` output) with `(value, path)`. A user-supplied `redactCensor` string or function replaces it wholesale. `createRedactor({ paths, censor })` compiles the walker once per `createLogger` — never per event.
- Auto-detection reads, in order: explicit option, documented env var, then filesystem/runtime (`package.json` walked up from `process.cwd()`, `os.hostname()`). Keep `resolveConfig` pure — the impure `detectContext()` (package.json + hostname) is called once in `createLogger` and its result passed in.
- **`expressMiddleware` shares the AsyncLocalStorage from `context.js`** (via `withContext`). Handler `enrichEvent()` calls mutate the same store the middleware emits on `finish` — if you ever give the middleware its own `AsyncLocalStorage`, Express enrichment silently breaks.

## Release & publish

- Semver, starting at `0.1.0`. Changelog lives in the README (or `CHANGELOG.md` once it grows).
- Publish: `npm version <patch|minor|major>` then `npm publish --access public` (scoped package).
- The published tarball is `src/` + `README.md` + `LICENSE` via the `files` field — verify with `npm pack --dry-run` before publishing.
