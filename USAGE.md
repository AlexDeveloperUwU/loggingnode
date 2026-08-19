# Usage philosophy & migration guide

This document explains **why** `@alexdevuwu/logging` is shaped the way it is, and gives a concrete recipe for migrating an existing project's logging onto it. For the full API reference (options, env vars, redaction paths, Seq setup), see [README.md](README.md) — this document doesn't repeat that, it explains the reasoning behind it.

It's written to be self-contained: read this, understand the mental model, and you (human or agent) should be able to migrate a project's logging correctly without re-deriving the philosophy from first principles or accidentally reinventing the wide-event pattern wrong.

## The core thesis

**Log what happened to the request, not what your code is doing.**

This is the argument made by [loggingsucks.com](https://loggingsucks.com/) and, independently, by Stripe's canonical-log-line practice: most logging is written from the code's point of view — "entered function X", "calling the payment API", "got a response" — and almost none of it is written from the _incident's_ point of view: "what happened to this specific request, end to end, and why."

The code's-eye-view style produces 10–20 scattered lines per request, each with partial context (a user ID here, a duration there, an error somewhere else), correlated after the fact by grepping for a request ID — if one was even logged consistently. That correlation work is manual, slow, and exactly the thing you don't have time for during an incident.

The fix isn't "log more" or "log less" — it's **log differently**: build one event that describes the whole unit of work, and emit it once. Every design decision in this library exists to make that one wide event easier to build correctly, harder to build incorrectly, and cheap to query afterward.

## Why "wide events," not just "structured logging"

Structured logging (JSON instead of printf strings) solves parseability. It does not solve the scattering problem — you can have twenty perfectly-structured JSON lines per request and still spend an afternoon reconstructing what happened.

Wide events solve the scattering problem directly:

- **Traditional (narrow) logging**: many log lines per request, each capturing a slice of context, correlated after the fact via a shared `request_id` (if you're lucky) — the debugging story only exists as a scattered set of rows you have to reassemble by hand.
- **Wide events**: one row per unit of work (a request, a job run, a queue message), enriched incrementally as the work happens, emitted exactly once when the work finishes — success or failure. The row _is_ the debugging story, already assembled, and it's also the analytics unit.

That second property is what makes wide events powerful beyond debugging: "show me failed checkouts for enterprise customers with the new payment flow enabled, grouped by error code" becomes a single query over one event type, not a multi-line correlation exercise across a dozen log statements. The [README's checkout example](README.md#wide-events-the-point-of-this-library) is the concrete illustration — one event, one `enrichEvent` call per fact learned during the request, one emission in a `finally` block.

This is why `startEvent`/`enrichEvent`/`endEvent` exist as three separate functions instead of one `logger.info()` call: the _shape_ of building up a wide event over time, across the whole request lifecycle, needs to be a first-class pattern in the API, not something you approximate by manually merging objects yourself.

## Why handlers enrich, they never log

A wide event only works if there is exactly one event per unit of work. The moment a handler calls `logger.info()` directly mid-request, you're back to scattered narrow lines competing with the wide event for attention — and the reader has no way to know which one has the full picture.

So the rule is structural, not just stylistic: application code calls `enrichEvent()` to add facts it has learned (`user`, `order_id`, `feature_flags`, whatever is relevant), and only the _boundary_ — Express middleware's `finish` handler, or the `finally` block wrapping a job — calls `endEvent()` to actually emit. This is also why the Express middleware exists as a first-class piece of the library rather than "just an example": it owns emission so handler code structurally cannot emit a second, competing line. CLAUDE.md's guardrail — never more than one log line per request from middleware — is the enforcement of this same idea at the implementation level.

## Why emission happens in a `finally`/completion path

An event that only gets emitted on the success path is worse than useless — the requests that _fail_ are exactly the ones you need the wide event for. Emitting from a `finally` (or the `finish`/`close` event on an HTTP response) guarantees the event exists whether the request succeeded, threw, or timed out, and guarantees it's emitted exactly once — not zero times (silently swallowed by an early return), not multiple times (a handler and a middleware both logging).

`@outcome` exists as an explicit enum field (`success | client_error | server_error | error | unknown`) precisely so failure is a queryable dimension of the event, not something you infer from the presence or absence of an `@error` field. `client_error`/`server_error` are role-based — request-side fault vs. handler-side fault — and apply to any call site, not just an HTTP framework's status code (see [README.md](README.md#outcome-semantics)).

## Why the raw logger is still exposed

If the whole pitch is "one wide event per request," it's fair to ask why `logger` is exported at all instead of forcing everything through `startEvent`/`enrichEvent`/`endEvent`. The answer: those three functions aren't a separate logging system, they're a thin staging layer on top of the same logger. `startEvent`/`enrichEvent` never call the logger — they just mutate a plain object held in `AsyncLocalStorage`. Only `endEvent` does, and it does it exactly once, via `emitOutcome`:

```js
// emitOutcome, simplified — see src/context.js
const fault = isFaultOutcome(outcome); // true only for server_error/error
const level = resolveOutcomeLevel(outcome); // 'info'/'error' by default, overridable per-outcome
logger[level](event, fault ? "Request failed" : "Request completed");
```

So there is never a competing "second logging system" — there's one logger, and one convenience layer for the specific shape of "fields accumulated over the lifetime of a request, emitted once at the end." That layer only makes sense for things that _have_ a lifetime and an end — a request, a job run, a queue message.

Note the two questions `emitOutcome` answers are deliberately separate: _what happened_ (`fault`, baked into the message text) versus _how loudly should this show up_ (`level`, which you can override per outcome via `createLogger({ outcomeLevels })` — see [Which pino level each outcome is emitted at](README.md#which-pino-level-each-outcome-is-emitted-at)). A `client_error` you want surfaced more visibly can be routed to `warn` without becoming a "the service is broken" `error` line — the message still honestly says "Request completed," because it did, just noisily.

Plenty of real log lines don't: server startup, shutdown, a one-off migration script, a fatal config error before anything else has run. These have no `@request_id`, no duration, no outcome — forcing them through `startEvent`/`endEvent` would be nonsensical, since there's no "did this unit of work succeed or fail" story to tell. For those, call `logger` directly. That's also why the README's log-level guidance lists "wide events **and** significant lifecycle moments" together under `info` — they're two different shapes of the same level, not two different systems to choose between arbitrarily.

The rule, stated as a single question: **does what you're logging belong to a request/job that's still in progress?** Yes → `enrichEvent` (never call the logger directly from inside a handler — that reintroduces the scattered-lines problem this library exists to prevent). No → call `logger`/`logger.child()` directly; the wide-event functions don't apply because there's no unit of work to attach fields to.

## Why AsyncLocalStorage, not parameter threading

The obvious alternative to a hidden per-request store is to pass a `logger`/`context` object explicitly through every function call between the entry point and wherever a fact is discovered. That doesn't scale: every function signature in the call chain picks up a parameter it doesn't otherwise need, purely to ferry logging context, and every new call site is a chance to forget it.

`AsyncLocalStorage` lets any code, at any depth in the call stack, call `enrichEvent()` and land on the correct request's event — no threading, no parameter pollution. The trade-off is one real caveat worth knowing before you rely on it: code that breaks async context propagation (pooled callbacks, cached event emitters that were created outside the current async chain) can silently drop enrichment, because the implicit link to "which request am I in" is gone. `startEvent()` returns the event object specifically as an escape hatch for those rare cases — you can thread it manually if you know a code path breaks propagation.

## Why `@`-prefixed metadata

Every field the library injects — `@service`, `@request_id`, `@duration_ms`, `@outcome`, `@error` — carries an `@` prefix. This isn't decoration; it's namespacing. Application fields (`order_id`, `user.subscription`) and library/system fields need to stay visually and mechanically distinguishable as a codebase grows and as more engineers touch it, otherwise it becomes ambiguous whether `status_code` in a given event came from the library or from application code that happened to pick the same name. The convention is borrowed directly from Seq's own metadata fields (`@mt`, `@x`, `@l`), so it composes with Seq's UI and query language instead of fighting it.

## Why field names are a schema, not a style choice

`snake_case`, `_ms`/`_cents` unit suffixes, money in minor units, nested objects per domain (`user: {...}`, `order: {...}`), a fixed outcome enum, a uniform error shape (`{ type, message, code, stack, cause? }`) — none of this is arbitrary code style. Log field names are a **cross-service schema**: the moment two services disagree on whether duration is `duration` or `durationMs` or `duration_ms`, or whether money is dollars or cents, cross-service queries and dashboards break or silently give wrong answers. The convention exists so that if every service in an organization uses this library, their events can be queried together without per-service translation.

This is also why **high cardinality is treated as a feature, not a cost** — `@request_id`, `user_id`, order IDs belong directly in events. Modern log/event stores (Seq included) index high-cardinality fields cheaply, and those are exactly the fields that make an event useful for isolating one specific incident rather than a class of incidents.

## Why redaction is proportional (75/25), not blanket masking

Blanket masking (`password: '***'`) protects the secret but destroys all signal — you can't tell two different masked tokens apart, which matters when you're trying to confirm "is this the same leaked-looking value we saw in the other event" during an investigation. Proportional masking (75% hidden, last 25% visible, `'***'` outright for anything under 3 characters) keeps enough of the tail visible to recognize or correlate a value without exposing enough to reuse it.

This is also why redaction is the library's own compiled walker rather than pino's built-in `redact` path-list option: pino's option matches wildcards only one level deep and is `O(paths × depth)` per top-level key, which is both the wrong complexity and the wrong matching semantics for catching a secret field nested arbitrarily deep in a request body. The library's walker matches a key name at _any_ depth by default, with exact-chain and mid-chain-wildcard syntax available when you need precision — see the [Redaction section of the README](README.md#redaction) for the mechanical details and default path list.

## Why the `[APP] ·` message tag

Every message gets a constant three-letter service tag (`[BIL] · Order created`). The tag is _constant per service_ deliberately — Seq groups messages into templates (`@mt`) based on the message string, so if the prefix varied per event (e.g. included a request ID), otherwise-identical messages would never group together and Seq's template view would be useless. A constant tag gives a human scanning a mixed console (multiple services' output interleaved, e.g. in local dev) an instant visual anchor for "which service emitted this" without breaking Seq's grouping for anyone querying centrally.

## Why zero-config auto-detection

A logging library that requires configuration before it produces useful output will, in practice, sometimes not get configured — someone will forget to set `SERVICE_NAME`, and the library needs to degrade gracefully rather than throw or silently omit fields. Service name, version, and instance ID resolve through a fallback chain (explicit option → env var → `package.json`/`os.hostname()` → `'unknown'`) specifically so `createLogger()` with zero arguments produces a fully-formed, if less specific, wide event — with a one-time stderr warning if it had to fall all the way back, so the gap gets noticed without breaking anything.

## Anti-patterns, and why each one breaks debugging

- **`console.log`** — unstructured, unlevelled, unqueryable, uncorrelated with anything else about the request. It can't participate in a wide event at all.
- **Per-file logger instances** — instantiating a new logger (with its own config) in every module fragments configuration and makes it impossible to reason about what a given logger will actually do. Configure once via `createLogger`, and use `logger.child({ component })` for module-scoped context instead — a child logger inherits the same destinations, redaction, and base fields.
- **String-interpolated messages** — `logger.info(\`order ${id} failed\`)`bakes the variable into the message string, so every distinct order ID produces a distinct Seq template and destroys`@mt`grouping (the exact thing that makes "show me all instances of this message" a query instead of a search). Pass the same static message and put the variable in a field:`logger.info({ order_id: id }, 'Order failed')`.
- **Scattered lines per request** — even ten well-structured lines are worse than one wide event, because none of them individually has the full picture and reconstructing it costs time you don't have mid-incident.
- **Missing request correlation** — without a propagated `@request_id`, a multi-service request can't be reassembled across service boundaries at all. Every event carries one; forward it as `x-request-id` on outbound calls.
- **Logging secrets** — default redaction covers common field names, but a new secret-bearing field (a new API integration, a new form field) needs to be added to `redact` deliberately. Assume nothing is redacted by accident — it's a compiled, explicit path list.

---

## Library usage — how it all works in practice

This section is the practical counterpart to everything above: what to import, what each piece does, and how the pieces fit together end to end. For exhaustive option/env-var tables, see the [README](README.md#configuration) — this walks through the same surface as a working mental model instead of a reference table.

### Installation

```bash
npm install @alexdevuwu/logging
```

`pino-pretty` is an optional peer — install it as a dev dependency if you want pretty console output locally:

```bash
npm install --save-dev pino-pretty
```

Requires Node **>= 18** (>= 20 recommended). Pure ESM — `import`, not `require`.

### The two halves of the API

Everything the library exports falls into one of two groups:

1. **The logger itself** — `createLogger`/`initLogger`/`getLogger`/`resetLogger` from `@alexdevuwu/logging`, plus `logger.child()`. This is "how do I get a pino instance configured the way this library configures it."
2. **The wide-event lifecycle** — `startEvent`/`enrichEvent`/`endEvent`/`withContext`/`getContext` from the same package. This is "how do I build up and emit the one event per unit of work." These functions read/write an `AsyncLocalStorage`-backed store; they don't take a logger argument because they operate on whichever event the current async context is inside.

A third, optional piece — `expressMiddleware` from `@alexdevuwu/logging/express` — wires the two together for HTTP: it calls `startEvent`/`endEvent` for you around each request, so Express handlers only ever touch `enrichEvent`.

**These aren't two competing ways to log — group 2 is built on top of group 1.** `startEvent`/`enrichEvent` never call the logger; they only stage fields on a plain object in `AsyncLocalStorage`. `endEvent` is the only one that calls `logger.info`/`.error`, and it does so exactly once. So the decision is never "which logging system do I use," it's one question: **does this belong to a request/job that's still in progress?**

- **Yes** (it has a `@request_id`, a `job_run_id`, some unit of work it's part of) → `enrichEvent`. Never call `logger` directly from inside a handler.
- **No** (server startup, shutdown, a migration script, a fatal error before anything else has run) → call `logger`/`logger.child()` directly. There's no unit of work for `startEvent`/`enrichEvent`/`endEvent` to attach to.

```js
logger.info({ port: 3000 }, "Server listening"); // lifecycle, no request → raw logger
// ...
enrichEvent({ order_id: order.id }); // inside a request → enrich, never log directly
```

See [Why the raw logger is still exposed](#why-the-raw-logger-is-still-exposed) above for the full reasoning.

### Creating a logger

```js
import { createLogger } from "@alexdevuwu/logging";

const { logger, flush, close } = createLogger({ service: "billing-api" });
```

`createLogger(options)` is synchronous and returns `{ logger, flush, close }`:

- `logger` — a configured pino instance. Use it directly for one-off, non-request-scoped lines (`logger.info(...)`, `logger.error(...)`) and via `logger.child({ component: 'stripe' })` for module-scoped context that doesn't need its own destinations.
- `flush()` — flushes buffered Seq batches without closing streams; rarely needed directly.
- `close()` — flushes everything and tears down streams; call this on shutdown (see [Graceful shutdown](#graceful-shutdown-1) below).

`service` is the only option you'll set most of the time — everything else (`version`, `instanceId`, `environment`, `level`) auto-detects. Explicit options > env vars > auto-detected/defaults, always. Pull the full options table from the [README](README.md#options) when you need something beyond the common case (Seq tuning, custom redaction, a custom `destination` for tests).

If a module needs a shared logger without threading it through imports, use the singleton pair instead of a module-level `createLogger` call: `initLogger(options)` once at startup, then `getLogger()` anywhere else — it throws if `initLogger` was never called, so a missing startup call fails loudly instead of silently logging nowhere.

### Building and emitting a wide event

The four lifecycle functions map directly onto a request/job's phases:

```js
import { startEvent, enrichEvent, endEvent } from "@alexdevuwu/logging";

startEvent({ "@request_id": incomingId, "@route": "/checkout" }); // 1. open the event
enrichEvent({ order_id: order.id, total_cents: order.totalCents }); // 2. add facts as you learn them (call as many times as needed)
endEvent("success"); // 3. compute duration, merge base fields, emit exactly once
```

- **`startEvent(initialFields?)`** — opens a new event in the current async context, stamps a start time and a `@request_id` (generated via `crypto.randomUUID()` if you don't supply one), and returns the event object (the escape hatch mentioned above, for code that breaks async propagation). Call it once per unit of work, as early as possible.
- **`enrichEvent(fields)`** — deep-merges `fields` into the current context's event. Safe to call any number of times, from any depth in the call stack, as long as you're still inside the same async chain `startEvent` was called in. This is the only function application/handler code should call.
- **`endEvent(outcome, extra?)`** — merges `extra` (typically `{ err }` on failure), computes `@duration_ms` from the `startEvent` timestamp, sets `@outcome`, and emits the line at whichever pino level `@outcome` resolves to (`info`/`error` by default — see [Which pino level each outcome is emitted at](README.md#which-pino-level-each-outcome-is-emitted-at) for the full default table and how to override it via `outcomeLevels`). Call it exactly once, from a `finally` block or equivalent completion path — never from a place that might run twice or might not run at all. See [Outcome semantics](README.md#outcome-semantics) for what value to pass.
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

### Scoping context: `withContext`

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

### Using it in Express

```js
import express from "express";
import { createLogger, enrichEvent } from "@alexdevuwu/logging";
import { expressMiddleware } from "@alexdevuwu/logging/express";

const { logger, close } = createLogger({ service: "billing-api" });
const app = express();

app.use(expressMiddleware(logger)); // mount early — before routes

app.post("/checkout", async (req, res) => {
  const order = await createOrder(req.body);
  enrichEvent({ user: { id: req.user.id }, total_cents: order.totalCents });
  res.status(201).json(order);
});
```

`expressMiddleware(logger)` does everything the manual try/finally shape above does, automatically, per request: opens the context, calls `startEvent` with method/route/user-agent/request-id (honoring an inbound `x-request-id` header, echoing it back on the response), determines `@outcome` from the final status code, and calls `endEvent` on the response's `finish` event. Route handlers never call `startEvent`/`endEvent` themselves — only `enrichEvent`. Mount it before your routes so every request is wrapped, including ones that 404.

### Using it outside a web framework

There's no HTTP dependency in the core package — `expressMiddleware` is the _only_ framework-specific piece, and it's an opt-in subpath import (`@alexdevuwu/logging/express`). CLIs, background workers, cron jobs, and queue consumers use exactly the pattern shown under `withContext` above: one `withContext` + `startEvent`/`endEvent` pair per independent unit of work.

### Errors

Never hand-format an error for logging. Pass it as a field named `err` (or `error`) and let the configured serializer normalize it:

```js
try {
  await charge(orderId);
} catch (err) {
  endEvent("error", { err }); // → @error: { type, message, code, stack, cause? }
}
```

`serializeError` (also exported directly, for cases outside the wide-event flow) produces the uniform shape every service using this library shares, with `cause` chains serialized and depth-bounded so a deeply nested cause chain can't blow up an event's size.

### Redaction in practice

Redaction is automatic and requires no per-call opt-in — every object argument passed to a log call (including `enrichEvent` fields, since they end up as fields on the emitted event) is walked and matched against `DEFAULT_REDACT_PATHS` before it's ever serialized:

```js
enrichEvent({
  user: { id: "u_1" },
  headers: { authorization: "Bearer abc123..." },
});
// emitted: headers.authorization → '****...23...' (proportionally masked), everything else untouched
```

Add project-specific secret field names via `redact` at `createLogger` time; remove a default only via the explicit `redactRemove` opt-out. See [Redaction](README.md#redaction) for the full default path list and path syntax (`*` wildcards, exact chains).

### Seq

Setting `SEQ_SERVER_URL` (or passing `seq.serverUrl`) turns on Seq ingestion alongside whatever else is configured — pretty console output and Seq can both be active at once in development. No code changes are needed at call sites; the same `logger.info`/`enrichEvent`/`endEvent` calls flow to Seq automatically once the stream is configured. See [Seq setup](README.md#seq-setup) for running a local Seq instance and the full option passthrough.

### Shutdown

```js
const { close } = createLogger({ service: "billing-api" });

process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
process.on("SIGINT", () => void close().finally(() => process.exit(0)));
```

`close()` flushes pino and any buffered Seq batch before the process exits; skipping it risks losing whatever Seq hadn't flushed yet. It's idempotent and never throws. See [Graceful shutdown](README.md#graceful-shutdown) for a version with a timeout guard.

### Testing code that uses this library

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

---

## Migration playbook

A step-ordered recipe for moving an existing project's logging onto this library. This section is intentionally terse — it points back into the README for mechanical detail rather than repeating it.

1. **Inventory the existing call sites.** Find every `console.log`/`console.warn`/`console.error`, winston/bunyan/pino-raw usage, and ad hoc `req.log`-style call. Bucket each one as either "happens inside a request/job's lifecycle" (a candidate for `enrichEvent`) or "genuinely standalone" (startup, shutdown, one-off migration scripts — a candidate for its own `logger.info` line).

2. **Install and smoke-test zero-config.** `createLogger({ service: '<name>' })`, run it, and confirm the auto-detected `@service`/`@version`/`@instance_id`/`@environment` look right _before_ touching any call sites — see [Auto-detection](README.md#auto-detection).

3. **Identify the unit-of-work boundary** for each entry point type:
   - **Express/HTTP** → mount [`expressMiddleware`](README.md#express-middleware); it owns `startEvent`/timing/status/emission. Handlers only call `enrichEvent`.
   - **Non-HTTP** (CLI, worker, cron, queue consumer) → wrap the unit of work in [`withContext`](README.md#outside-web-applications-cli-workers-cron-queues), with manual `startEvent`/`endEvent` in a try/finally.

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

5. **Fix field names and message casing while you're in there.** Rename ad hoc fields to `snake_case` with unit suffixes (`duration_ms`, not `durationMs`/`elapsed`), money in minor units, and let serialized errors go through the library's `err`/`error` serializers instead of hand-rolled error formatting — see [Field conventions](README.md#field-conventions). Write message text in sentence case (`"Order created"`, not `"order created"` or `"ORDER CREATED"`) to match the library's own built-in messages.

6. **Audit redaction.** Compare the project's existing sensitive field names against [`DEFAULT_REDACT_PATHS`](README.md#redaction); add anything project-specific via `redact`. Don't assume the defaults cover a bespoke field name (e.g. a third-party API's odd secret key name).

7. **Wire graceful shutdown**, if not already present: `close()` in `SIGTERM`/`SIGINT` handlers — see [Graceful shutdown](README.md#graceful-shutdown). If migrating from a library that already flushes on shutdown, verify the new `close()` call replaces it rather than stacking alongside it.

8. **Verify.** Run `npm test`, then smoke-run one real request or job with `pretty: true` and eyeball the resulting wide event: does it read as a complete, honest account of what happened? If you find yourself wanting to add a `debug` line to understand a request, that's a sign a field is missing from the wide event, not a sign you need more log lines.
