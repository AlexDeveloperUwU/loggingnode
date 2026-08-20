# Usage guide

This is the complete developer reference for `@alexdevuwu/logging`: every export, every option, every table, full walkthroughs for every entry-point type, and a step-ordered migration playbook — everything you need to actually use the library correctly, in one document. For the reasoning behind these decisions, see [SPEC.md](SPEC.md). [README.md](../README.md) is the short overview these two link out from.

## Installation

```bash
npm install @alexdevuwu/logging
```

`pino-pretty` is an optional peer — install it as a dev dependency if you want pretty console output locally:

```bash
npm install --save-dev pino-pretty
```

If you skip this and `pretty` resolves to `true` anyway (the default outside production), the library doesn't throw or block startup — it silently falls back to raw JSON on stdout with a one-time stderr warning. If your local console suddenly shows unformatted JSON instead of colored output, this is why; run the install command above.

Requires Node **>= 18** (>= 20 recommended). Pure ESM — `import`, not `require`.

Runnable, complete examples live in [`examples/`](../examples/) — `basic.js` (plain logger), `wide-event.js`, `express.js`, `nested-operations.js`, `shutdown.js`. `npm run example:<name>` runs any of them.

## The two halves of the API

Everything the library exports falls into one of two groups:

1. **The logger itself** — `createLogger`/`initLogger`/`getLogger`/`resetLogger` from `@alexdevuwu/logging`, plus `logger.child()`. This is "how do I get a pino instance configured the way this library configures it."
2. **The wide-event lifecycle** — `startEvent`/`enrichEvent`/`endEvent`/`withContext`/`withOperation`/`getContext` from the same package. This is "how do I build up and emit the one event per unit of work" (`startEvent`/`enrichEvent`/`endEvent`/`withContext`), plus the one exception — `withOperation`, for a nested sub-action whose own outcome deserves a second, correlated row (see [Why `withOperation`, not nested `startEvent`](SPEC.md#why-withoperation-not-nested-startevent) in SPEC.md). These functions read/write an `AsyncLocalStorage`-backed store; they don't take a logger argument because they operate on whichever event the current async context is inside.

A third, optional piece — `expressMiddleware` from `@alexdevuwu/logging/express` — wires the two together for HTTP: it opens the request's context and emits its event for you around each request, so Express handlers only ever touch `enrichEvent`. (It doesn't literally call `startEvent`/`endEvent` — see [Using it in Express](#using-it-in-express) for what it actually does and why that distinction matters.)

**These aren't two competing ways to log — group 2 is built on top of group 1.** `startEvent`/`enrichEvent` never call the logger; they only stage fields on a plain object in `AsyncLocalStorage`. `endEvent` is the only one that calls `logger.info`/`.error`, and it does so exactly once. So the decision is never "which logging system do I use," it's one question: **does this belong to a request/job that's still in progress?**

- **Yes** (it has a `@request_id`, a `job_run_id`, some unit of work it's part of) → `enrichEvent`. Never call `logger` directly from inside a handler.
- **No** (server startup, shutdown, a migration script, a fatal error before anything else has run) → call `logger`/`logger.child()` directly. There's no unit of work for `startEvent`/`enrichEvent`/`endEvent` to attach to.

```js
logger.info({ port: 3000 }, "Server listening"); // lifecycle, no request → raw logger
// ...
enrichEvent({ order_id: order.id }); // inside a request → enrich, never log directly
```

See [Why the raw logger is still exposed](SPEC.md#why-the-raw-logger-is-still-exposed) in SPEC.md for the full reasoning.

## Every export, at a glance

**Core — what most projects actually call:**

| Export                             | From                          | What it's for                                                                                                                   |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `createLogger(options)`            | `@alexdevuwu/logging`         | Build a configured logger instance. The primary entry point — most projects call this exactly once.                             |
| `startEvent(fields?)`              | `@alexdevuwu/logging`         | Opens the one wide event for the current unit of work.                                                                          |
| `enrichEvent(fields)`              | `@alexdevuwu/logging`         | Adds facts to the active event. The function application code calls the most.                                                   |
| `endEvent(outcome, extra?)`        | `@alexdevuwu/logging`         | Finalizes and emits the active event, exactly once.                                                                             |
| `withContext(fields, fn)`          | `@alexdevuwu/logging`         | Opens the `AsyncLocalStorage` scope itself, for non-HTTP entry points.                                                          |
| `withOperation(name, fields?, fn)` | `@alexdevuwu/logging`         | Tracks a nested sub-action as its own correlated child event — see [Nested operations](#nested-operations-withoperation) below. |
| `expressMiddleware(logger)`        | `@alexdevuwu/logging/express` | The one framework-specific piece, an opt-in subpath import — see [Using it in Express](#using-it-in-express).                   |

**Advanced — real, but most projects won't need these directly:**

| Export                                | From                  | What it's for                                                                                                                                                          |
| ------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initLogger(options)` / `getLogger()` | `@alexdevuwu/logging` | Module-level singleton pair for when you can't thread a logger through imports. `getLogger()` throws if `initLogger` was never called.                                 |
| `getContext()`                        | `@alexdevuwu/logging` | Read-only access to the current event object.                                                                                                                          |
| `DEFAULT_OUTCOME_LEVELS`              | `@alexdevuwu/logging` | Frozen object — the canonical list of valid `@outcome` values (its keys) and their default pino levels. See [Outcome semantics](#outcome-semantics).                   |
| `isFaultOutcome(outcome)`             | `@alexdevuwu/logging` | `true` for `server_error`/`error` — whether an outcome represents a failure on _your_ side.                                                                            |
| `resolveOutcomeLevel(outcome)`        | `@alexdevuwu/logging` | Resolves the pino level for an outcome, honoring a configured `outcomeLevels` override.                                                                                |
| `DEFAULT_REDACT_PATHS`                | `@alexdevuwu/logging` | The default redaction path list — see [Redaction](#redaction-in-practice).                                                                                             |
| `defaultCensor(value, path)`          | `@alexdevuwu/logging` | The built-in 75/25 proportional mask function.                                                                                                                         |
| `buildRedact(options)`                | `@alexdevuwu/logging` | Builds a pino-compatible `redact` config object (paths + censor) — for composing this library's redaction into your own pino instance instead of using `createLogger`. |
| `createRedactor({ paths, censor })`   | `@alexdevuwu/logging` | Compiles the actual redaction walker — same use case as `buildRedact`, lower-level.                                                                                    |
| `serializeError(err)`                 | `@alexdevuwu/logging` | The uniform `{ type, message, code, stack, cause? }` error shape, usable outside the wide-event flow too.                                                              |

**Test-only — for your own test suite, not application code:**

| Export                                    | From                  | What it's for                                                                                                                                       |
| ----------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resetLogger()` + `resetRequestContext()` | `@alexdevuwu/logging` | Used together — clears the singleton logger and its wired outcome-level config between your own test files/cases. Neither alone fully resets state. |

Not listed at all: `initRequestContext` and `resolveConfig` are also exported, but both are internal wiring `createLogger` calls for you — reach for `createLogger` instead of either of them directly.

Everything except `expressMiddleware` comes from the single `@alexdevuwu/logging` entry point — one import line covers the whole core API.

## Creating a logger

```js
import { createLogger } from "@alexdevuwu/logging";

const { logger, flush, close } = createLogger({ service: "billing-api" });
```

`createLogger(options)` is synchronous and returns `{ logger, flush, close }`:

- `logger` — a configured pino instance. Use it directly for one-off, non-request-scoped lines (`logger.info(...)`, `logger.error(...)`) and via `logger.child({ component: 'stripe' })` for module-scoped context that doesn't need its own destinations.
- `flush()` — flushes buffered Seq batches without closing streams; rarely needed directly.
- `close()` — flushes everything and tears down streams; call this on shutdown (see [Shutdown](#shutdown) below).

`service` is the only option you'll set most of the time — everything else (`version`, `instanceId`, `environment`, `level`) auto-detects. Explicit options **always** override environment variables, which **always** override defaults.

If a module needs a shared logger without threading it through imports, use the singleton pair instead of a module-level `createLogger` call: `initLogger(options)` once at startup, then `getLogger()` anywhere else — it throws if `initLogger` was never called, so a missing startup call fails loudly instead of silently logging nowhere.

## Configuration reference

Every `createLogger(options)` option:

| Option                     | Type               | Default                                                          | Description                                                                                        |
| -------------------------- | ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `service`                  | string             | `SERVICE_NAME` → package.json `name` → `'unknown'` (tag `[UNK]`) | Service name → `@service`; source of the `[APP]` message tag                                       |
| `level`                    | string             | `LOG_LEVEL` or `info` (prod) / `debug` (dev)                     | Minimum pino level: `trace`/`debug`/`info`/`warn`/`error`/`fatal`                                  |
| `environment`              | string             | `NODE_ENV` or `'development'`                                    | → `@environment` base field                                                                        |
| `version`                  | string             | `SERVICE_VERSION` → package.json `version` → `'unknown'`         | Deployed version → `@version`                                                                      |
| `instanceId`               | string             | `HOSTNAME` → `os.hostname()` → random UUID                       | → `@instance_id`                                                                                   |
| `pretty`                   | boolean            | `true` unless production                                         | Pretty-print to stdout (requires `pino-pretty`)                                                    |
| `seq`                      | object             | enabled iff `serverUrl` set                                      | Seq stream config — see [Seq](#seq)                                                                |
| `seq.serverUrl`            | string             | `SEQ_SERVER_URL`                                                 | Seq ingestion endpoint, e.g. `http://localhost:5341`                                               |
| `seq.apiKey`               | string             | `SEQ_API_KEY`                                                    | Optional Seq API key                                                                               |
| `seq.maxBatchingTime`      | number             | pino-seq default                                                 | Max ms a batch is held before sending                                                              |
| `seq.eventSizeLimit`       | number             | pino-seq default                                                 | Per-event byte cap                                                                                 |
| `seq.batchSizeLimit`       | number             | pino-seq default                                                 | Per-batch byte cap                                                                                 |
| `seq.onError`              | function           | stderr                                                           | Delivery-failure handler — **never log inside it** (recursion risk)                                |
| `seq.additionalProperties` | object             | —                                                                | Context dictionary attached to every Seq event                                                     |
| `seq.logOtherAs`           | string             | —                                                                | Seq level for unstructured (non-JSON) output: `'Verbose'`…`'Fatal'`                                |
| `seq.*`                    | any                | —                                                                | Any other [`seq-logging`](https://github.com/datalust/seq-logging) option passes through untouched |
| `seqLevel`                 | string             | `'info'` (dev) / `'warn'` (prod)                                 | Minimum level routed to Seq                                                                        |
| `outcomeLevels`            | object             | see [Outcome semantics](#outcome-semantics)                      | Per-`@outcome` pino level overrides for wide-event emission, merged over the built-in defaults     |
| `redact`                   | string[]           | —                                                                | Extra redaction paths, union-merged with the defaults                                              |
| `redactRemove`             | string[]           | —                                                                | Deliberately remove default redaction paths                                                        |
| `redactCensor`             | string \| function | proportional mask                                                | Replacement value, or `(value, path) => string` for full control                                   |
| `base`                     | object             | —                                                                | Extra pino `base` fields merged into every event                                                   |
| `serializers`              | object             | —                                                                | Extra pino serializers merged over the defaults                                                    |
| `destination`              | Writable           | —                                                                | Inject a custom destination (test seam); bypasses stream assembly                                  |
| `stdoutAsync`              | boolean            | `true`                                                           | Use `pino.destination({ sync: false })` for stdout in production                                   |

The "Default" column above is the auto-detection fallback chain, read left to right: explicit option first, then the sources after it in order, `package.json` walked upward from `process.cwd()`. `@node_version` (`process.version`) is always included in the base fields too, with no fallback chain — it's just `process.version`. If no service name is found anywhere, the service falls back to `'unknown'` (tag `[UNK]`) with a one-time stderr warning — name your service.

**Environment variables:**

| Variable                   | Default                           | Purpose                                                                                                            |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SERVICE_NAME`             | auto-detected from `package.json` | Service name (used when the `service` option is absent)                                                            |
| `LOG_LEVEL`                | `info` (prod) / `debug` (dev)     | Minimum log level                                                                                                  |
| `NODE_ENV`                 | `development`                     | Environment; drives pretty/level defaults                                                                          |
| `SERVICE_VERSION`          | `unknown`                         | `@version` base field                                                                                              |
| `HOSTNAME`                 | random UUID                       | `@instance_id` base field                                                                                          |
| `SEQ_SERVER_URL`           | —                                 | Enables the Seq stream when set                                                                                    |
| `SEQ_API_KEY`              | —                                 | Seq API key                                                                                                        |
| `LOG_PRETTY`               | on unless production              | `1`/`true`/`0`/`false`                                                                                             |
| `LOG_REDACT_PATHS`         | —                                 | Comma-separated paths _added_ to `redact` (does not remove defaults — that's `redactRemove`, code-only, see below) |
| `SEQ_MAX_BATCHING_TIME_MS` | pino-seq default                  | Seq batching window                                                                                                |
| `SEQ_EVENT_SIZE_LIMIT`     | pino-seq default                  | Per-event byte cap                                                                                                 |
| `SEQ_BATCH_SIZE_LIMIT`     | pino-seq default                  | Per-batch byte cap                                                                                                 |

Production combined with pretty printing, or `trace`/`debug` levels in production, also emits a one-time stderr warning — validation never crashes your app over configuration, it just tells you when something looks off.

**Everything else in the options table above is code-only** — `createLogger(options)` is the only way to set it, there's no env var equivalent. Concretely: `outcomeLevels`, `seqLevel`, `stdoutAsync`, `redactRemove`, `redactCensor`, `base`, `serializers`, and `destination` don't have one — if you need one of these to vary between environments, read it from your own env var and pass it into `createLogger` yourself, e.g. `createLogger({ seqLevel: process.env.MY_SEQ_LEVEL })`. Don't go looking for a `SEQ_LEVEL`/`LOG_STDOUT_ASYNC`/`LOG_OUTCOME_LEVELS`-shaped var — none exist.

## Message format & the `[APP] ·` tag

Every message is automatically prefixed with a constant three-letter service tag: `[BIL] · Order created`. The tag is the first three letters of the service name, uppercased, `*`-padded for short names (`ap` → `AP*`, `x` → `X**`), `UNK` when no service name is found — computed once at `createLogger` time, so it never varies per event. See [SPEC.md](SPEC.md) for why it's constant rather than including per-event context.

Write the message text itself (the part after `· `) in **sentence case** — capitalize only the first word: `"Order created"`, not `"order created"` or `"ORDER CREATED"`. The library's own built-in messages (`Request completed`, `Request failed`, `Operation completed`, `Operation failed`) follow this convention; match it for application messages too.

## Log levels — guidance

All pino levels are available, but the library is designed around a simpler discipline:

- **`info`** — wide events and significant lifecycle moments (startup, shutdown, migrations)
- **`error`** — unexpected failures, always with a serialized `err`
- **`debug`/`trace`** — local development noise; assume they're disabled in production
- **`warn`** — sparingly; a warning nobody acts on is noise

If you reach for `debug` to understand a request, add a field to the wide event instead — you'll have it in production too, not just in a local session.

## Building and emitting a wide event

The four lifecycle functions map directly onto a request/job's phases:

```js
import { startEvent, enrichEvent, endEvent } from "@alexdevuwu/logging";

startEvent({ "@request_id": incomingId, "@route": "/checkout" }); // 1. open the event
enrichEvent({ order_id: order.id, total_cents: order.totalCents }); // 2. add facts as you learn them (call as many times as needed)
endEvent("success"); // 3. compute duration, merge base fields, emit exactly once
```

- **`startEvent(initialFields?)`** — opens a new event in the current async context, stamps a start time and a `@request_id` (generated via `crypto.randomUUID()` if you don't supply one), and returns the event object (the escape hatch mentioned above, for code that breaks async propagation). Call it once per unit of work, as early as possible.
- **`enrichEvent(fields)`** — deep-merges `fields` into the current context's event. Safe to call any number of times, from any depth in the call stack, as long as you're still inside the same async chain `startEvent` was called in. This is the only function application/handler code should call.
- **`endEvent(outcome, extra?)`** — merges `extra` (typically `{ err }` on failure), computes `@duration_ms` from the `startEvent` timestamp, sets `@outcome`, and emits the line at whichever pino level `@outcome` resolves to (`info`/`error` by default — see [Outcome semantics](#outcome-semantics) for the full table and how to override it via `outcomeLevels`). Call it exactly once, from a `finally` block or equivalent completion path — never from a place that might run twice or might not run at all.
- **`getContext()`** — reads the current event object without mutating it; useful for conditionals (`if (getContext()?.user) ...`) or for logging library internals that need read-only access.

The full try/catch/finally shape for any unit of work — HTTP or not — is:

```js
async function unitOfWork() {
  startEvent({/* known up front */});
  let outcome = "success";
  try {
    /* ...do the work, calling enrichEvent as you learn things... */
  } catch (err) {
    outcome = "error"; // or 'client_error' / 'server_error' — see Outcome semantics
    endEvent(outcome, { err });
    throw err;
  } finally {
    if (outcome === "success") endEvent(outcome);
  }
}
```

If part of that work is a sub-action with its own independently meaningful outcome (a notification send, a payment call), wrap just that part in `withOperation` instead of calling `startEvent` again — see the next section for the full shape.

## Nested operations: `withOperation`

```js
import { withOperation, enrichEvent } from "@alexdevuwu/logging";

async function sendWarning(userId, reason) {
  return withOperation(
    "send-warning",
    { user_id: userId, reason },
    async () => {
      await notificationService.send(userId, "content-warning");
      // throws → captured as this operation's own @error/outcome: "error",
      // without failing the parent request
    },
  );
}
```

`withOperation(name, fields?, fn)` runs `fn` in its own `AsyncLocalStorage` scope (`als.run`, not `enterWith`), so it's safe even when several run concurrently under the same parent via `Promise.all` — each gets an isolated child event, and the parent's context is restored automatically once `fn` settles, regardless of ordering. `fields` is optional; `withOperation(name, fn)` works too.

What you get, mechanically:

- The child event gets its own `@operation_id`, a `@parent_operation_id` pointing at the parent's `@operation_id`, and the parent's shared `@request_id`.
- It's finalized and emitted as its own log line (`"Operation completed"`/`"Operation failed"`) the instant `fn` returns or throws — never something a stray `endEvent()` call inside `fn` can override (that call becomes a safe no-op with a one-time warning instead).
- The parent event gets a `@child_operations` array — `{ operation_id, name, duration_ms, outcome }` per entry — capped at 50, with `@child_operations_truncated` counting the rest past the cap. The parent row alone tells you which sub-actions ran and how they did, without opening their individual lines.
- Recursion is free — a `withOperation` called from inside another one chains `@parent_operation_id` to its immediate parent, arbitrarily deep.
- Calling `startEvent()` again instead of `withOperation` (the mistake this function exists to prevent) doesn't corrupt anything any more — it merges into the active event and warns once.

**Reach for it narrowly** — see [Why `withOperation`, not nested `startEvent`](SPEC.md#why-withoperation-not-nested-startevent) in SPEC.md for when a sub-action deserves this vs. plain `enrichEvent`.

## Scoping context: `withContext`

`startEvent` needs an active `AsyncLocalStorage` context to attach its event to. Inside Express (once `expressMiddleware` is mounted) that context already exists for the lifetime of the request. Outside Express — a CLI command, a cron job, a queue consumer — you create that context explicitly with `withContext`:

```js
import {
  withContext,
  startEvent,
  enrichEvent,
  endEvent,
} from "@alexdevuwu/logging";

await withContext({ job: "nightly-settlement" }, async () => {
  startEvent({ "@job": "nightly-settlement" });
  try {
    const result = await settle();
    enrichEvent({ settled_count: result.count });
    endEvent("success");
  } catch (err) {
    endEvent("error", { err });
    throw err;
  }
});
```

The object passed to `withContext` seeds fields available for the whole callback; `startEvent` inside it opens the actual emitted event. One `withContext` call per independent unit of work (one per job run, one per queue message) — don't wrap an entire long-lived worker process in a single `withContext`, or every message it ever processes collapses into one (wrong) event.

## Using it in Express

```js
import { expressMiddleware } from "@alexdevuwu/logging/express";

app.use(expressMiddleware(logger)); // mount early — before routes
```

That's the entire integration surface — see [README's wide-events example](../README.md#wide-events) for it in a full request handler, or run [`examples/express.js`](../examples/express.js) directly.

`expressMiddleware(logger)` does everything the manual try/finally shape above does, automatically, per request — but not by calling `startEvent`/`endEvent` under the hood. It opens the request's `AsyncLocalStorage` context directly via `withContext`, seeding the event with method/route/user-agent/request-id itself (honoring an inbound `x-request-id` header, echoing it back on the response), then on the response's `finish` event reads whatever's in that context, determines `@outcome` from the final status code, and emits. Route handlers only ever call `enrichEvent` by convention — mount it before your routes so every request is wrapped, including ones that 404.

**This convention isn't enforced, and that has a real consequence.** Because the middleware seeds its own store instead of calling `startEvent`, the store already looks "started" to `endEvent()` — so if a handler calls `endEvent()` directly anyway, it _works_: it computes duration, emits a line with whatever outcome the handler chose, and marks the event finished. The middleware's own `finish` handler then sees the event is already finished and silently skips its own emission — so you get exactly one line, but with the handler's outcome instead of the status-code-derived one, and the middleware's automatic status-code logic never ran. If you need to override the outcome from inside a handler, do it before the response is sent by influencing the status code (or by wrapping the risky part in `withOperation` if it deserves its own row) rather than reaching for `endEvent()` — it isn't blocked, just not the intended path.

## Using it outside a web framework

There's no HTTP dependency in the core package — `expressMiddleware` is the _only_ framework-specific piece, and it's an opt-in subpath import (`@alexdevuwu/logging/express`). CLIs, background workers, cron jobs, and queue consumers use exactly the pattern shown under `withContext` above: one `withContext` + `startEvent`/`endEvent` pair per independent unit of work.

## Outcome semantics

`@outcome` is `'success' | 'client_error' | 'server_error' | 'error' | 'unknown'` — `DEFAULT_OUTCOME_LEVELS`'s keys are the full, canonical list; there's no separate enum export because that object already is one. `client_error`/`server_error` are **role-based**, not HTTP-specific:

- `client_error` — the request-maker sent something bad (malformed, invalid, unauthorized).
- `server_error` — the handler failed despite a valid request.
- `error` — no request/response shape applies at all (a parsing bug, a corrupted file, a logic error).
- `unknown` — outcome couldn't be determined.

Passing anything else (a typo like `"succes"`) doesn't get logged verbatim — `endEvent`/`withOperation` silently normalize it to `"unknown"` with a one-time stderr warning naming the valid values.

**Express** determines this automatically from the response status code — a route handler never sets it by hand:

```
// Missing/invalid field in the request body → client_error (their request, not your bug)
// Valid request, but the DB connection drops mid-handler → server_error (you broke on a fine request)
```

**Non-HTTP** — you decide, based on which side of the interaction failed:

```js
await withContext({ job: "nightly-settlement" }, async () => {
  startEvent({ job_run_id: run.id });
  try {
    await callDownstreamApi(payload);
    endEvent("success");
  } catch (err) {
    // Stale API key / malformed payload sent downstream → client_error
    // Valid payload, but the downstream API 500s → server_error
    const outcome = err.statusCode >= 500 ? "server_error" : "client_error";
    endEvent(outcome, { err });
    throw err;
  }
});
```

The same code path can legitimately emit different outcome values across different calls it makes — `@outcome` describes the failed _interaction_, not a fixed identity of the service. This redefinition of what the field means doesn't imply the library runs outside Node — `node:crypto`/`AsyncLocalStorage`/pino output are all Node-only; running this library in a browser isn't supported.

**Pino level per outcome** — `@outcome` (the queryable fact) and the emitted pino level (how loudly it shows up) are separate concerns:

| `@outcome`     | pino level |
| -------------- | ---------- |
| `success`      | `info`     |
| `client_error` | `info`     |
| `server_error` | `error`    |
| `error`        | `error`    |
| `unknown`      | `info`     |

`client_error` stays at `info` by default — a correctly-rejected bad request isn't a bug in your service, and routing it to `error` floods error-level alerting with noise nobody should page on. Override per project:

```js
const { logger } = createLogger({
  service: "billing-api",
  outcomeLevels: { client_error: "warn" }, // surface bad requests more visibly, without treating them as a fault
});
```

Only real pino levels are accepted; an invalid value is ignored with a one-time stderr warning, falling back to the default for that outcome. The message text (`"Request completed"` vs. `"Request failed"`) still reflects whether the outcome is a fault, regardless of which level you route it to — overriding the level changes volume, not meaning.

## Field conventions

Consistent field names are what make cross-service queries possible:

| Convention                | Examples                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| snake_case everywhere     | `@request_id`, `@status_code`, `@user_agent`                                              |
| Unit suffixes             | `@duration_ms`, `@latency_ms`, `total_cents`, `lifetime_value_cents`                      |
| Money in minor units      | `249900` not `2499.00`                                                                    |
| Nested objects per domain | `user: { id, subscription }`, `cart: { ... }`, `payment: { ... }`                         |
| Outcome enum              | `@outcome: 'success' \| 'client_error' \| 'server_error' \| 'error' \| 'unknown'`         |
| Uniform error shape       | `@error: { type, message, code, stack, cause? }` (cause chains serialized, depth-bounded) |
| ISO-8601 UTC timestamps   | `@timestamp` (`2026-08-03T19:00:00.000Z`, automatic)                                      |

High cardinality is a feature, not a cost: `@request_id`, `user_id`, order IDs belong directly in your events. Modern log/event stores (Seq included) index high-cardinality fields cheaply, and those are exactly the fields that make an event useful for isolating one specific incident rather than a class of incidents — see [Why field names are a schema, not a style choice](SPEC.md#why-field-names-are-a-schema-not-a-style-choice) in SPEC.md.

## Errors

Never hand-format an error for logging. Pass it as a field named `err` (or `error`) and let the configured serializer normalize it:

```js
try {
  await charge(orderId);
} catch (err) {
  endEvent("error", { err }); // → @error: { type, message, code, stack, cause? }
}
```

`serializeError` (also exported directly, for cases outside the wide-event flow) produces the uniform shape every service using this library shares, with `cause` chains serialized and depth-bounded so a deeply nested cause chain can't blow up an event's size.

## Redaction in practice

Redaction is automatic and requires no per-call opt-in — every object argument passed to a log call (including `enrichEvent` fields, since they end up as fields on the emitted event) is walked and matched against `DEFAULT_REDACT_PATHS` before it's ever serialized. Masking is proportional to the value's length: values shorter than 3 characters become `***`; otherwise 75% of the characters are replaced with `*` and the **last 25%** stay visible (`'supersecret'` → `'********ret'`) — enough signal to recognize or correlate a leaked-adjacent value without exposing it.

Default paths covered — matched at **any** nesting depth by name alone:

`password`, `passwd`, `secret`, `authorization`, `x-api-key`, `cookie`, `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apiKey`, `private_key`, `credit_card`, `card_number`, `cvv`, `ssn`

One exception: `set-cookie` is **header-path-only**, not any-depth by name — it only redacts as `headers["set-cookie"]`. A field literally named `set_cookie` sitting outside a `headers` object is **not** redacted by default; add it to `redact` explicitly if your app has one.

```js
enrichEvent({
  user: { id: "u_1" },
  headers: { authorization: "Bearer abc123..." },
});
// emitted: headers.authorization → '****...23...' (proportionally masked), everything else untouched

const { logger } = createLogger({
  service: "billing-api",
  redact: ["session_id", "*.session_id"], // add project-specific paths
  redactRemove: ["token"], // deliberately remove a default (be sure!)
});

// Replace the censor wholesale with a fixed string, or (value, path) => string for full control:
const { logger: custom } = createLogger({
  service: "billing-api",
  redactCensor: (value, path) =>
    `${value}`.slice(-4).padStart(`${value}`.length, "*"),
});
```

Path syntax: `password`/`*.password` matches the key at any depth; `headers.authorization`/`headers["x-api-key"]` is an exact chain from the root (bracket notation supported); `req.*.authorization` — `*` matches any single key in the chain. `redactRemove` removes a name **and every variant of it** (`token` also removes `*.token`, `headers["set-cookie"]`-style entries with the same leaf name) — an explicit escape hatch; removing a default should always be a conscious, reviewable decision.

**How it works.** This is the library's own single-pass compiled walker, not pino's built-in path-list `redact` — see [Why redaction is proportional](SPEC.md#why-redaction-is-proportional-7525-not-blanket-masking) in SPEC.md for why. It runs before serialization, never mutates your objects, and returns the same reference (zero allocation) when nothing matches.

## Seq

Run Seq locally:

```bash
docker run --name seq -d --restart unless-stopped -e ACCEPT_EULA=Y -p 5341:80 datalust/seq:latest
```

Then point the library at it — no code changes needed at call sites, the same `logger.info`/`enrichEvent`/`endEvent` calls flow to Seq automatically once the stream is configured:

```bash
export SEQ_SERVER_URL=http://localhost:5341
# export SEQ_API_KEY=...  # if your Seq instance requires one
```

Events arrive with proper Seq semantics: `msg` becomes the message template (`@mt`), so identical messages group together — exactly why you pass data as fields, never string-interpolated into the message. Serialized errors become Seq exceptions (`@x`). All event fields arrive as a fully queryable property dictionary. Pretty console output and Seq can both be active simultaneously in development — a convenient way to validate your Seq pipeline locally.

pino levels map to Seq levels:

| pino         | Seq         |
| ------------ | ----------- |
| `trace` (10) | Verbose     |
| `debug` (20) | Debug       |
| `info` (30)  | Information |
| `warn` (40)  | Warning     |
| `error` (50) | Error       |
| `fatal` (60) | Fatal       |

**Full Seq feature support** — everything `pino-seq`/`seq-logging` offers is available through the `seq` option (see the [Configuration reference](#configuration-reference) table above): message templating, context dictionaries via `seq.additionalProperties`, batching controls, `logOtherAs` for unstructured output, API-key auth. Any option the underlying `seq-logging` client accepts passes through untouched — the library never hides Seq functionality from you.

## Shutdown

```js
import { createLogger } from "@alexdevuwu/logging";

const { logger, close } = createLogger({ service: "billing-api" });

async function shutdown(signal) {
  logger.info({ signal }, "Shutdown requested");
  try {
    await Promise.race([
      close(), // flushes pino + the Seq batch buffer (idempotent)
      new Promise((resolve) => setTimeout(resolve, 5000)), // don't hang forever
    ]);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

pino-seq batches events before sending — calling `process.exit()` without flushing **discards buffered batches**. `close()` flushes pino and any buffered Seq batch, is idempotent, and never throws (flush failures are reported on stderr); the `Promise.race` timeout guard just bounds how long shutdown can take if a flush hangs. `SIGKILL`/`SIGSEGV` can't be trapped — that's what the batching window bounds, not this handler.

## Testing code that uses this library

Inject a synchronous in-memory `Writable` via the `destination` option instead of mocking pino:

```js
import { createLogger } from "@alexdevuwu/logging";

const lines = [];
const destination = new Writable({
  write(chunk, _enc, cb) {
    lines.push(JSON.parse(chunk.toString()));
    cb();
  },
});
const { logger } = createLogger({ service: "test", destination });
```

This is the same seam the library's own test suite uses — assert against `lines` instead of parsing stdout or stubbing pino internals.

## Common mistakes

- **`console.log`** — unstructured, unlevelled, unqueryable, uncorrelated with anything else about the request. It can't participate in a wide event at all.
- **Per-file logger instances** — instantiating a new logger (with its own config) in every module fragments configuration and makes it impossible to reason about what a given logger will actually do. Configure once via `createLogger`, and use `logger.child({ component })` for module-scoped context instead — a child logger inherits the same destinations, redaction, and base fields.
- **String-interpolated messages** — ``logger.info(`order ${id} failed`)`` bakes the variable into the message string, so every distinct order ID produces a distinct Seq template and destroys `@mt` grouping (the exact thing that makes "show me all instances of this message" a query instead of a search). Pass the same static message and put the variable in a field: `logger.info({ order_id: id }, 'Order failed')`.
- **Scattered lines per request** — even ten well-structured lines are worse than one wide event, because none of them individually has the full picture and reconstructing it costs time you don't have mid-incident.
- **Missing request correlation** — without a propagated `@request_id`, a multi-service request can't be reassembled across service boundaries at all. Every event carries one; forward it as `x-request-id` on outbound calls.
- **Logging secrets** — default redaction covers common field names, but a new secret-bearing field (a new API integration, a new form field) needs to be added to `redact` deliberately. Assume nothing is redacted by accident — it's a compiled, explicit path list, and remember `set-cookie` is header-path-only (see [Redaction in practice](#redaction-in-practice) above).
- **Nested `startEvent()` calls** — a helper that calls `startEvent()` mid-request instead of `enrichEvent()` used to silently reset the active event out from under the caller. It no longer corrupts data — it merges and warns — but it's still the wrong call: use `withOperation()` for a nested sub-action that needs its own outcome, `enrichEvent()` for everything else.
- **Calling `endEvent()` inside an Express handler** — not blocked, but it hijacks the middleware's automatic status-code-based outcome with whatever the handler passed instead. See [Using it in Express](#using-it-in-express) above.

---

## Migration playbook

A step-ordered recipe for moving an existing project's logging onto this library.

1. **Inventory the existing call sites.** Find every `console.log`/`console.warn`/`console.error`, winston/bunyan/pino-raw usage, and ad hoc `req.log`-style call. Bucket each one as either "happens inside a request/job's lifecycle" (a candidate for `enrichEvent`) or "genuinely standalone" (startup, shutdown, one-off migration scripts — a candidate for its own `logger.info` line).

2. **Install and smoke-test zero-config.** `createLogger({ service: '<name>' })`, run it, and confirm the auto-detected `@service`/`@version`/`@instance_id`/`@environment` look right _before_ touching any call sites — see [Configuration reference](#configuration-reference) above.

3. **Identify the unit-of-work boundary** for each entry point type:
   - **Express/HTTP** → mount [`expressMiddleware`](#using-it-in-express); it owns `startEvent`/timing/status/emission. Handlers only call `enrichEvent`.
   - **Non-HTTP** (CLI, worker, cron, queue consumer) → wrap the unit of work in [`withContext`](#scoping-context-withcontext), with manual `startEvent`/`endEvent` in a try/finally.

4. **Convert each inventoried call site.** For each one, ask: _does this describe something about the current unit of work, or is it truly independent?_ If the former, it becomes an `enrichEvent` field, not a log call:

   ```js
   // before
   console.log("user", userId, "logged in");
   // after — inside a request already wrapped by expressMiddleware/withContext
   enrichEvent({ user: { id: userId } });
   ```

   ```js
   // before — scattered try/catch logging
   console.log("processing order", orderId);
   try {
     await charge(orderId);
     console.log("charge succeeded");
   } catch (err) {
     console.error("charge failed", err);
   }
   // after — one wide event, outcome captured, err serialized uniformly
   enrichEvent({ order_id: orderId });
   try {
     await charge(orderId);
   } catch (err) {
     endEvent("error", { err });
     throw err;
   }
   ```

5. **Convert nested `startEvent` misuse.** Some inventoried call sites won't be plain `console.log` calls — they'll be a helper that calls `startEvent()` again mid-request (a habit carried over from thinking of it as "just start logging this part"). Recognize the pattern — a function called from inside an already-wrapped request/job that opens its own event instead of enriching the existing one — and convert it to `withOperation` if its outcome deserves its own row, or plain `enrichEvent` if it doesn't:

   ```js
   // before — a real example, from a booking API's POST handler and its service layer
   api.post("/", async (req, res) => {
     try {
       const bookingData = req.body;
       if (
         !bookingData?.eventId ||
         !bookingData?.space ||
         !bookingData?.bookedBy
       ) {
         logger.error("Invalid booking data - missing required fields");
         return res
           .status(400)
           .json(ErrorManager.returnError("invalidParameters"));
       }
       logger.info(
         `Creating booking for event: ${bookingData.eventId} by user: ${bookingData.bookedBy}`,
       );
       const result = await bookings.addBooking(bookingData);
       return res.status(result.code).json(result);
     } catch (error) {
       logger.error(`Error in /api/bookings/ [POST]: ${error.message}`);
       return res.status(500).json(ErrorManager.handleError(error));
     }
   });
   // ...and deep in the service layer, addBooking() logs its own scattered lines
   // for the availability check it runs before writing anything.

   // after
   api.post("/", async (req, res) => {
     const bookingData = req.body;
     enrichEvent({
       event_id: bookingData?.eventId,
       booked_by: bookingData?.bookedBy,
     });
     try {
       if (
         !bookingData?.eventId ||
         !bookingData?.space ||
         !bookingData?.bookedBy
       ) {
         return res
           .status(400)
           .json(ErrorManager.returnError("invalidParameters"));
       }
       const result = await bookings.addBooking(bookingData); // uses withOperation internally, see below
       return res.status(result.code).json(result);
     } catch (error) {
       return res.status(500).json(ErrorManager.handleError(error));
     }
   });
   // inside addBooking(), the availability check is independently meaningful
   // (did this space/date conflict with an existing booking) — its own row:
   const availability = await withOperation(
     "check-space-availability",
     { space_id: booking.space, event_id: booking.eventId },
     () =>
       checkSpaceAvailability(
         booking.space,
         booking.bookingDate,
         booking.eventId,
       ),
   );
   ```

   `expressMiddleware` (mounted once) now owns emission — no more manual `res.status(...).json(...)` paired with a separate `logger.error` call that can drift out of sync with the actual response.

6. **Fix field names and message casing while you're in there.** Rename ad hoc fields to `snake_case` with unit suffixes (`duration_ms`, not `durationMs`/`elapsed`), money in minor units, and let serialized errors go through the library's `err`/`error` serializers instead of hand-rolled error formatting — see [Field conventions](#field-conventions) above. Write message text in sentence case (`"Order created"`, not `"order created"` or `"ORDER CREATED"`) to match the library's own built-in messages.

7. **Audit redaction.** Compare the project's existing sensitive field names against [`DEFAULT_REDACT_PATHS`](#redaction-in-practice); add anything project-specific via `redact`. Don't assume the defaults cover a bespoke field name (e.g. a third-party API's odd secret key name).

8. **Wire graceful shutdown**, if not already present: `close()` in `SIGTERM`/`SIGINT` handlers — see [Shutdown](#shutdown) above. If migrating from a library that already flushes on shutdown, verify the new `close()` call replaces it rather than stacking alongside it.

9. **Verify.** Run `npm test`, then smoke-run one real request or job with `pretty: true` and eyeball the resulting wide event: does it read as a complete, honest account of what happened? If you find yourself wanting to add a `debug` line to understand a request, that's a sign a field is missing from the wide event, not a sign you need more log lines.
