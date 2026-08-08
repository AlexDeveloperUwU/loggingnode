# Plan: `@alexdevuwu/logging` (AlexDevUwU.Logging) — Architecture, README, CLAUDE.md

## Context

`D:\Documents\Dev\Packages\LoggingNode` is a fresh GitLab repo (boilerplate README, one commit). Goal: a reusable, pure-JavaScript Node.js logging library on **pino + pino-pretty + pino-seq**, enforcing wide-event structured-logging best practices (loggingsucks.com + the local best-practices skill bundle analyzed during planning).

**Deliverables of this task (docs, not library code):**

1. This architecture & feature plan.
2. `README.md` (replaces boilerplate) — install, quick start, config, enforced best practices.
3. `CLAUDE.md` — AI-assistant guidelines, structure, commands, standards, guardrails.

Library scaffolding (package.json, src/, tests) is the **next** task, executed against this plan.

### Fixed decisions (confirmed with user)

- Pure JavaScript, **ESM only** (`"type": "module"`), no TypeScript, no build step.
- Package name **`@alexdevuwu/logging`** (npm requires lowercase).
- Tests: **`node:test`** built-in, zero test deps.
- Node >= 18 (>= 20 recommended); license **MIT**; start at `0.1.0`.

### Verified constraints driving the design

- **pino-seq@4** is ESM-only and exposes only `createStream(config)` → an **in-process `Writable`** used as `pino(options, stream)`. It has **no `pino.transport()`/worker support** ⇒ dual output must use **`pino.multistream`**.
- pino-seq config: `serverUrl`, `apiKey`, `maxBatchingTime`, `eventSizeLimit`, `batchSizeLimit`, `onError`, `additionalProperties`, `logOtherAs`. **Must `await stream.flush()` before exit**; delivery errors surface only via `onError`.
- pino-seq mapping: pino levels 10/20/30/40/50/60 → Verbose/Debug/Information/Warning/Error/Fatal; `msg` → `@mt`; `err`/`error` → `@x` + merged props. Peer: pino v10.

---

## Architecture & Feature Plan (Deliverable 1)

### Project structure (target state)

```
├── package.json            # @alexdevuwu/logging, type:module, exports: "." + "./express"
├── README.md / CLAUDE.md / LICENSE / .gitignore
├── src/
│   ├── index.js            # public barrel
│   ├── config.js           # resolveConfig(options, env) — pure, frozen result
│   ├── logger.js           # createLogger / initLogger / getLogger / flush / close
│   ├── context.js          # AsyncLocalStorage + wide-event lifecycle
│   ├── streams.js          # multistream assembly: pretty / JSON stdout / pino-seq
│   ├── redaction.js        # DEFAULT_REDACT_PATHS + the compiled deep-redaction walker
│   ├── serializers.js      # err/error serializers {type,message,code,stack,cause?}
│   └── middleware/express.js  # expressMiddleware(logger) — one wide event per request
├── test/                   # one .test.js per src module (node:test)
└── examples/               # basic.js, wide-event.js, express.js, shutdown.js
```

### Public API

- `createLogger(options)` → `{ logger, flush, close }` — explicit factory (primary). `service` is **auto-detected** (option > `SERVICE_NAME` > nearest `package.json` name > `'unknown'` + one stderr warning); never throws for missing context.
- `initLogger(options)` / `getLogger()` — opt-in memoized convenience; `getLogger()` **throws** before init (fail fast, never silently auto-configures).
- Wide events (`context.js`, AsyncLocalStorage-backed):
  - `startEvent(fields)` — seeds `request_id` (inbound `x-request-id` honored, else `crypto.randomUUID()`), start time.
  - `enrichEvent(fields)` — deep-merges business context during the lifecycle.
  - `endEvent(outcome, extra?)` — emits **exactly one** line (`info` on success, `error` on failure) with all fields + `duration_ms` + serialized `error`; called in `finally`.
  - `withContext(fields, fn)` — ALS scope for non-HTTP code (workers, cron).
- `expressMiddleware(logger)` — owns timing/status/outcome/emission; echoes `x-request-id` response header; handlers only enrich.
- `await flush()` / `await close()` — flush pino + pino-seq batch buffer; `close()` is idempotent and never throws (stderr on failure).

### Core features

- **Log levels**: all pino levels exposed; docs steer to `info` (wide events) + `error` (failures); `debug`/`trace` for local dev.
- **Child loggers**: standard `logger.child({ component })`.
- **Contextual enrichment**: env context via pino `base` — `service`, `version`, `environment`, `instance_id`, `node_version` — **auto-detected** at startup: option > env var > `package.json` (name/version, walked up from cwd) > `os.hostname()` > `'unknown'`/random UUID.
- **Message tag**: every message prefixed `[APP] · ` via pino `hooks.logMethod` — first 3 letters of service name, uppercased, `*`-padded (`AP*`, `A**`), `UNK` fallback. Constant per service ⇒ Seq `@mt` grouping unaffected.
- **Redaction**: pino `redact` with `DEFAULT_REDACT_PATHS` (password/passwd/secret/authorization/x-api-key/cookie/token/access_token/refresh_token/id_token/api_key/private_key/credit_card/card_number/cvv/ssn + `*.`-wildcard and `headers.*` variants). **Censor is a proportional-mask function**: value < 3 chars → `***`; else mask all but the **last 25%** with `*` (75% hidden). User paths union-merged; deliberate opt-out via `redactRemove`; `redactCensor` accepts a string or custom `(value, path) => string`.
- **Full Seq passthrough**: the `seq` option object goes to `createStream` with only documented defaults applied — message templating, `additionalProperties` context dictionaries, `logOtherAs`, batching limits, and any other seq-logging option all work.
- **Framework-agnostic core**: no HTTP assumptions outside `src/middleware/express.js`; `withContext` covers CLIs, workers, cron, queues.
- **Error serialization**: `err` + `error` both → `pino.stdSerializers.err`; wide-event helper produces `{ type, message, code?, stack }`; non-Error throws wrapped as `NonErrorThrow`.
- **Formatting**: `formatters.level` → string labels; `pino.stdTimeFunctions.isoTime` → ISO-8601.

### Output / transport matrix (`streams.js` → `pino.multistream`)

| Scenario               | Streams                                    | Notes                                               |
| ---------------------- | ------------------------------------------ | --------------------------------------------------- |
| dev, no Seq            | pino-pretty → stdout                       | all levels                                          |
| dev + `SEQ_SERVER_URL` | pretty + pino-seq                          | Seq default level `info` (configurable `seqLevel`)  |
| prod, no Seq           | JSON → `pino.destination({ sync: false })` | all levels                                          |
| prod + Seq             | JSON stdout + pino-seq                     | Seq default `warn+` (stdout = full-fidelity record) |

Rationale for multistream over `pino.transport()`: pino-seq has no worker target; in-process is simpler and Seq batching already amortizes network cost. **Deviation from Plan-agent draft**: `createLogger` stays **synchronous** — pino-pretty (optional peer dep) is loaded via `createRequire(import.meta.url)` only when pretty is on; if absent, warn once on stderr and fall back to JSON (never crash over cosmetics).

### Configuration management

Precedence: **explicit option > env var > default**; `resolveConfig(options, env = process.env)` is pure and returns a frozen object (trivially testable).

Env vars: `SERVICE_NAME`, `LOG_LEVEL` (default `info` prod / `debug` dev), `NODE_ENV`, `SERVICE_VERSION`, `HOSTNAME`, `SEQ_SERVER_URL` (absent ⇒ Seq disabled), `SEQ_API_KEY`, `LOG_PRETTY`, `LOG_REDACT_PATHS` (CSV, merged), `SEQ_MAX_BATCHING_TIME_MS`, `SEQ_EVENT_SIZE_LIMIT`, `SEQ_BATCH_SIZE_LIMIT`.

Auto-detection resolution order (option > env > runtime > fallback):

| Field         | Resolution order                                                                    |
| ------------- | ----------------------------------------------------------------------------------- |
| `service`     | option → `SERVICE_NAME` → nearest `package.json` `name` → `'unknown'` (tag `[UNK]`) |
| `version`     | option → `SERVICE_VERSION` → nearest `package.json` `version` → `'unknown'`         |
| `instance_id` | option → `HOSTNAME` → `os.hostname()` → random UUID                                 |
| `environment` | option → `NODE_ENV` → `'development'`                                               |

Validation: no throw for missing service — auto-detect, fall back to `'unknown'` (tag `[UNK]`), warn once on stderr; one stderr warning if production + pretty/trace/debug. Never log inside `onError` (recursion) — stderr only.

### Testing strategy (node:test, zero deps)

Seam: `createLogger({ destination })` accepts an injected in-memory `Writable` capturing parsed JSON lines — no test touches stdout/Seq/network. Suites: config precedence matrix, base fields/level labels/child/memoization/flush idempotency, ALS isolation across interleaved async tasks, exactly-one-emission per event, redaction (default paths, any-depth nesting, censor, opt-out), serializers (incl. non-Error wrap + cause chains), multistream routing (seqLevel), Express middleware via stub req/res EventEmitter (no supertest). Command: `node --test test/`.

### Key risks (documented in README)

pino v10 peer alignment with pino-seq; in-process Seq stream on event loop (mitigated by batching + async stdout); flush-on-exit (`process.exit()` drops batches — shutdown recipe with `await close()` + timeout race); ALS overhead & lost-context failure modes; redaction cost bounded by one-line-per-request; string interpolation destroys Seq `@mt` template grouping (no sprintf-style API offered).

---

## README.md (Deliverable 2) — content plan

Replace boilerplate entirely. Sections:

1. **Title/badges/description** — `AlexDevUwU.Logging`, npm/license/Node>=18 badges; "opinionated structured logging for Node.js on pino; wide events, Seq aggregation, sane redaction, zero build step."
2. **Features** — wide events, request correlation, ALS context, pretty+JSON+Seq multistream, redaction defaults, env config, graceful shutdown, pure ESM, zero test deps.
3. **Requirements** — Node >= 18 (>= 20 recommended).
4. **Installation** — `npm install @alexdevuwu/logging`; optional `npm i -D pino-pretty` for dev pretty printing.
5. **Quick start** — ESM snippet: `createLogger({ service: 'billing-api' })`, `logger.info({...}, 'msg')`, `logger.child({ component: 'stripe' })`, expected JSON output.
6. **Wide events** — why-one-line-per-request paragraph + `startEvent`/`enrichEvent`/`endEvent` try/finally example with emitted event JSON.
7. **Express middleware** — `app.use(expressMiddleware(logger))`; `x-request-id` propagation/echo.
8. **Manual context** — `withContext` for workers/cron.
9. **Configuration** — full options table + full env-var table (per plan above).
10. **Log levels guidance** — info/error philosophy, debug/trace for dev, avoid warn sprawl.
11. **Field conventions** — snake_case, `_ms`/`_cents` suffixes, `outcome` enum, `error {type,message,code}`.
12. **Redaction** — default paths, adding paths, `redactRemove` escape hatch, censor string.
13. **Seq setup** — `docker run -e ACCEPT_EULA=Y -p 5341:80 datalust/seq:latest`; `SEQ_SERVER_URL=http://localhost:5341`; pino→Seq level mapping table; `@mt`/`@x` explanation.
14. **Graceful shutdown** — SIGTERM snippet with `await close()` + `Promise.race` timeout; why `process.exit()` loses Seq batches.
15. **Anti-patterns** — no `console.log`, no per-file loggers, no string interpolation, no scattered per-request lines, no uncorrelated logs.
16. **Development** — `npm test`, `npm run test:watch`, examples, layout.
17. **License** — MIT.

## CLAUDE.md (Deliverable 3) — content plan

1. **Project overview** — what/why; wide events are the point, not a feature.
2. **Commands** — `npm test` (`node --test test/`), `npm run test:watch`, `npm run lint`/`format` (eslint 9 flat config + prettier 3, dev-only), `npm run example:basic|express`.
3. **Repository structure map** — tree with one-line purpose per file.
4. **Coding standards** — pure ESM, no TS syntax/build; JSDoc `@param`/`@returns` on every public export; **camelCase JS identifiers but snake_case log fields** (called out as the #1 confusion source); async/await; Node >= 18 APIs.
5. **Testing conventions** — node:test + node:assert/strict only; injected `destination` seam; never require live Seq.
6. **Architectural guardrails (NEVER list)** — no CJS/dual-package; no `pino.transport()` with pino-seq (multistream only); never bypass redaction; never >1 log line per request in middleware; no new runtime deps without documented justification (keep pino + pino-seq); never log in `onError` (stderr only); `createLogger` stays pure (only documented `initLogger` memo); new env vars land in README table + `config.js` validation in the same change.
7. **Key external facts** — pino-seq level map, `flush()` requirement, multistream rationale, pino v10 peer.
8. **Release notes** — `npm version` + `npm publish --access public` (scoped), changelog in README.

## Files to create/modify

- **Modify:** `README.md` (replace boilerplate) — full content per §README plan.
- **Create:** `CLAUDE.md` — full content per §CLAUDE.md plan.
- No other files in this task (package.json/src/tests are follow-up per this plan).

## Verification

1. `README.md` renders correctly (markdown lint by inspection; all code blocks are valid ESM JavaScript — mentally trace `node --check`-equivalent for each snippet).
2. Every env var / option mentioned in README matches the configuration table in this plan (single source of truth).
3. CLAUDE.md commands match scripts the follow-up scaffold will define (`npm test` → `node --test test/`).
4. Cross-check best-practices section against the wide-events rules (one event/request, finally emission, request_id, base context) — nothing missing, nothing contradicting pino-seq's verified behavior (stream-only, flush-on-exit, level map).
5. Confirm no TypeScript syntax anywhere and no CJS (`require`/`module.exports`) in any snippet.
