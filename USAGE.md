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

Every message gets a constant three-letter service tag (`[BIL] · order created`). The tag is _constant per service_ deliberately — Seq groups messages into templates (`@mt`) based on the message string, so if the prefix varied per event (e.g. included a request ID), otherwise-identical messages would never group together and Seq's template view would be useless. A constant tag gives a human scanning a mixed console (multiple services' output interleaved, e.g. in local dev) an instant visual anchor for "which service emitted this" without breaking Seq's grouping for anyone querying centrally.

## Why zero-config auto-detection

A logging library that requires configuration before it produces useful output will, in practice, sometimes not get configured — someone will forget to set `SERVICE_NAME`, and the library needs to degrade gracefully rather than throw or silently omit fields. Service name, version, and instance ID resolve through a fallback chain (explicit option → env var → `package.json`/`os.hostname()` → `'unknown'`) specifically so `createLogger()` with zero arguments produces a fully-formed, if less specific, wide event — with a one-time stderr warning if it had to fall all the way back, so the gap gets noticed without breaking anything.

## Anti-patterns, and why each one breaks debugging

- **`console.log`** — unstructured, unlevelled, unqueryable, uncorrelated with anything else about the request. It can't participate in a wide event at all.
- **Per-file logger instances** — instantiating a new logger (with its own config) in every module fragments configuration and makes it impossible to reason about what a given logger will actually do. Configure once via `createLogger`, and use `logger.child({ component })` for module-scoped context instead — a child logger inherits the same destinations, redaction, and base fields.
- **String-interpolated messages** — `logger.info(\`order ${id} failed\`)`bakes the variable into the message string, so every distinct order ID produces a distinct Seq template and destroys`@mt`grouping (the exact thing that makes "show me all instances of this message" a query instead of a search). Pass the same static message and put the variable in a field:`logger.info({ order_id: id }, 'order failed')`.
- **Scattered lines per request** — even ten well-structured lines are worse than one wide event, because none of them individually has the full picture and reconstructing it costs time you don't have mid-incident.
- **Missing request correlation** — without a propagated `@request_id`, a multi-service request can't be reassembled across service boundaries at all. Every event carries one; forward it as `x-request-id` on outbound calls.
- **Logging secrets** — default redaction covers common field names, but a new secret-bearing field (a new API integration, a new form field) needs to be added to `redact` deliberately. Assume nothing is redacted by accident — it's a compiled, explicit path list.

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

5. **Fix field names while you're in there.** Rename ad hoc fields to `snake_case` with unit suffixes (`duration_ms`, not `durationMs`/`elapsed`), money in minor units, and let serialized errors go through the library's `err`/`error` serializers instead of hand-rolled error formatting — see [Field conventions](README.md#field-conventions).

6. **Audit redaction.** Compare the project's existing sensitive field names against [`DEFAULT_REDACT_PATHS`](README.md#redaction); add anything project-specific via `redact`. Don't assume the defaults cover a bespoke field name (e.g. a third-party API's odd secret key name).

7. **Wire graceful shutdown**, if not already present: `close()` in `SIGTERM`/`SIGINT` handlers — see [Graceful shutdown](README.md#graceful-shutdown). If migrating from a library that already flushes on shutdown, verify the new `close()` call replaces it rather than stacking alongside it.

8. **Verify.** Run `npm test`, then smoke-run one real request or job with `pretty: true` and eyeball the resulting wide event: does it read as a complete, honest account of what happened? If you find yourself wanting to add a `debug` line to understand a request, that's a sign a field is missing from the wide event, not a sign you need more log lines.
