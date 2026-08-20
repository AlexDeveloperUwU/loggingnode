# Design spec — the why

This document explains **why** `@alexdevuwu/logging` is shaped the way it is: every non-obvious design decision, argued from first principles, so a reader can tell whether a future change fits the library's actual point or just adds surface area. For **how** to use the library — every export, every option, full reference tables — see [USAGE.md](USAGE.md). [README.md](../README.md) is the short overview; this and USAGE.md are the deep reference pair it links to.

Read this once, understand the mental model, and you should be able to extend or migrate onto this library correctly without re-deriving the philosophy from first principles or accidentally reinventing the wide-event pattern wrong.

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

That second property is what makes wide events powerful beyond debugging: "show me failed checkouts for enterprise customers with the new payment flow enabled, grouped by error code" becomes a single query over one event type, not a multi-line correlation exercise across a dozen log statements. The [README's wide-events example](../README.md#wide-events) is the concrete illustration — one event, one `enrichEvent` call per fact learned during the request, one emission in a `finally` block.

This is why `startEvent`/`enrichEvent`/`endEvent` exist as three separate functions instead of one `logger.info()` call: the _shape_ of building up a wide event over time, across the whole request lifecycle, needs to be a first-class pattern in the API, not something you approximate by manually merging objects yourself.

## Why handlers enrich, they never log

A wide event only works if there is exactly one event per unit of work. The moment a handler calls `logger.info()` directly mid-request, you're back to scattered narrow lines competing with the wide event for attention — and the reader has no way to know which one has the full picture.

So the rule is structural, not just stylistic: application code calls `enrichEvent()` to add facts it has learned (`user`, `order_id`, `feature_flags`, whatever is relevant), and only the _boundary_ — Express middleware's `finish` handler, or the `finally` block wrapping a job — calls `endEvent()` to actually emit. This is also why the Express middleware exists as a first-class piece of the library rather than "just an example": it owns emission so handler code structurally cannot emit a second, competing line. `CLAUDE.md`'s guardrail — never more than one log line per request from middleware — is the enforcement of this same idea at the implementation level.

## Why emission happens in a `finally`/completion path

An event that only gets emitted on the success path is worse than useless — the requests that _fail_ are exactly the ones you need the wide event for. Emitting from a `finally` (or the `finish`/`close` event on an HTTP response) guarantees the event exists whether the request succeeded, threw, or timed out, and guarantees it's emitted exactly once — not zero times (silently swallowed by an early return), not multiple times (a handler and a middleware both logging).

`@outcome` exists as an explicit enum field (`success | client_error | server_error | error | unknown`) precisely so failure is a queryable dimension of the event, not something you infer from the presence or absence of an `@error` field. `client_error`/`server_error` are role-based — request-side fault vs. handler-side fault — and apply to any call site, not just an HTTP framework's status code (see [Outcome semantics](USAGE.md#outcome-semantics) in USAGE.md).

## Why the raw logger is still exposed

If the whole pitch is "one wide event per request," it's fair to ask why `logger` is exported at all instead of forcing everything through `startEvent`/`enrichEvent`/`endEvent`. The answer: those three functions aren't a separate logging system, they're a thin staging layer on top of the same logger. `startEvent`/`enrichEvent` never call the logger — they just mutate a plain object held in `AsyncLocalStorage`. Only `endEvent` does, and it does it exactly once, via `emitOutcome`:

```js
// emitOutcome, simplified — see src/context.js
const fault = isFaultOutcome(outcome); // true only for server_error/error
const level = resolveOutcomeLevel(outcome); // 'info'/'error' by default, overridable per-outcome
logger[level](event, fault ? "Request failed" : "Request completed");
```

So there is never a competing "second logging system" — there's one logger, and one convenience layer for the specific shape of "fields accumulated over the lifetime of a request, emitted once at the end." That layer only makes sense for things that _have_ a lifetime and an end — a request, a job run, a queue message.

Note the two questions `emitOutcome` answers are deliberately separate: _what happened_ (`fault`, baked into the message text) versus _how loudly should this show up_ (`level`, which you can override per outcome via `createLogger({ outcomeLevels })` — see [Outcome semantics](USAGE.md#outcome-semantics) in USAGE.md for the full default table). A `client_error` you want surfaced more visibly can be routed to `warn` without becoming a "the service is broken" `error` line — the message still honestly says "Request completed," because it did, just noisily.

Plenty of real log lines don't have a request to attach to: server startup, shutdown, a one-off migration script, a fatal config error before anything else has run. These have no `@request_id`, no duration, no outcome — forcing them through `startEvent`/`endEvent` would be nonsensical, since there's no "did this unit of work succeed or fail" story to tell. For those, call `logger` directly. That's also why [Log levels — guidance](USAGE.md#log-levels--guidance) in USAGE.md lists "wide events **and** significant lifecycle moments" together under `info` — they're two different shapes of the same level, not two different systems to choose between arbitrarily.

The rule, stated as a single question: **does what you're logging belong to a request/job that's still in progress?** Yes → `enrichEvent` (never call the logger directly from inside a handler — that reintroduces the scattered-lines problem this library exists to prevent). No → call `logger`/`logger.child()` directly; the wide-event functions don't apply because there's no unit of work to attach fields to.

## Why `withContext` is explicit, not automatic

It's fair to ask why every non-HTTP entry point has to call `withContext` itself instead of the library just opening a scope for you. The answer is that the library has no way to know, on its own, **where a unit of work begins**, outside of a framework that tells it.

For Express, "a unit of work" = "an HTTP request came in" — an unambiguous, framework-provided event, which is why `expressMiddleware` can hook it and auto-wrap every request in its own scope. A CLI script, a cron job, or a queue consumer has no equivalent universal hook: a CLI script might be one unit of work for the whole process, or a thousand (one per record it processes); a cron job's "start" is whatever the scheduler calls (`node-cron`, `agenda`, a raw `setInterval`, a container restart — a different shape every time); a queue consumer processes many messages in one long-running process, and only the consumer code knows when one message's handling begins and ends. The library can't guess any of that without either hard-coding support for every possible framework/scheduler (directly against the "core has no HTTP dependency, never couple to a framework" guardrail) or guessing wrong — and guessing wrong is worse than requiring the explicit call: if the library auto-opened one `withContext` scope for the entire process at startup, you'd get one giant event merging every unrelated job into a single row, silently destroying the one property wide events exist to guarantee (one row = one unit of work).

So `withContext` isn't a gap, it's a deliberate boundary: the library gives you the generic primitive, and — same as `expressMiddleware` is a thin, Express-specific adapter around it — any other framework gets its own thin adapter wrapping `withContext` around _that_ framework's own "a job just started" hook.

## Why `withOperation`, not nested `startEvent`

`startEvent()`'s underlying mechanism, `AsyncLocalStorage.enterWith()`, swaps the active event for the rest of the current execution with **no automatic restore**. That's fine for the one, top-level call — it's not fine if nested code (a notification send, a payment call) calls `startEvent()` again thinking it's starting its own event: it silently re-points the active store, and if two such nested calls ever run concurrently (e.g. both `await`ed via `Promise.all`), they stomp on each other's context, corrupting both.

`AsyncLocalStorage.run(store, fn)` is the primitive that actually solves this — it scopes a store to a callback and automatically restores the previous store once that callback settles, which is what makes it safe under concurrent siblings. `withOperation(name, fields, fn)` is built on `run`, not `enterWith`, specifically so a sub-action can get its own correlated event without corrupting the parent's.

**Reach for it narrowly.** `withOperation` is for a sub-action whose own success or failure is independently meaningful and worth querying/alerting on separately from the parent — a notification send, a payment call, an LLM call, a third-party API call — not a general-purpose wrapper for every internal function or DB call. The case that settled this design: a "handle message" request that, mid-handling, sends a warning to a flagged user. The request can legitimately report `@outcome: "success"` even if the warning send failed (the failure was logged and handled, not fatal to the request) — cramming that into a flat field on the parent event loses the warning's own duration and error detail, and doesn't let you alert on "warning delivery failure rate" without conflating it with unrelated fields. That's a real second row, not fragmentation for its own sake. Wrapping every DB call or internal helper in `withOperation` _would_ be the fragmentation this library's core thesis warns against — this is the line between the two. It also covers **mutually-exclusive branches**, not just concurrent siblings: a moderation handler that does _either_ `withOperation('warn', ...)` _or_ `withOperation('ban', ...)` depending on a prior offense count, never both, ends up with exactly one `@child_operations` entry either way — the parent tells you which branch fired and whether it succeeded, without accumulating a growing set of ad hoc boolean fields (`was_banned`, `was_warned`, `was_timed_out`, ...) as more branches get added over time.

A bare nested `startEvent()` — the mistake `withOperation` exists to prevent — doesn't corrupt the event any more: it merges into the active one and warns once, instead of silently resetting it. That's a safety net for the mistake, not a second supported way to do this.

## Why AsyncLocalStorage, not parameter threading

The obvious alternative to a hidden per-request store is to pass a `logger`/`context` object explicitly through every function call between the entry point and wherever a fact is discovered. That doesn't scale: every function signature in the call chain picks up a parameter it doesn't otherwise need, purely to ferry logging context, and every new call site is a chance to forget it.

`AsyncLocalStorage` lets any code, at any depth in the call stack, call `enrichEvent()` and land on the correct request's event — no threading, no parameter pollution. The trade-off is one real caveat worth knowing before you rely on it: code that breaks async context propagation (pooled callbacks, cached event emitters that were created outside the current async chain) can silently drop enrichment, because the implicit link to "which request am I in" is gone. `startEvent()` returns the event object specifically as an escape hatch for those rare cases — you can thread it manually if you know a code path breaks propagation.

## Why `@`-prefixed metadata

Every field the library injects — `@service`, `@request_id`, `@duration_ms`, `@outcome`, `@error` — carries an `@` prefix. This isn't decoration; it's namespacing. Application fields (`order_id`, `user.subscription`) and library/system fields need to stay visually and mechanically distinguishable as a codebase grows and as more engineers touch it, otherwise it becomes ambiguous whether `status_code` in a given event came from the library or from application code that happened to pick the same name. The convention is borrowed directly from Seq's own metadata fields (`@mt`, `@x`, `@l`), so it composes with Seq's UI and query language instead of fighting it.

## Why field names are a schema, not a style choice

`snake_case`, `_ms`/`_cents` unit suffixes, money in minor units, nested objects per domain (`user: {...}`, `order: {...}`), a fixed outcome enum, a uniform error shape (`{ type, message, code, stack, cause? }`) — none of this is arbitrary code style. Log field names are a **cross-service schema**: the moment two services disagree on whether duration is `duration` or `durationMs` or `duration_ms`, or whether money is dollars or cents, cross-service queries and dashboards break or silently give wrong answers. The convention exists so that if every service in an organization uses this library, their events can be queried together without per-service translation.

This is also why **high cardinality is treated as a feature, not a cost** — `@request_id`, `user_id`, order IDs belong directly in events. Modern log/event stores (Seq included) index high-cardinality fields cheaply, and those are exactly the fields that make an event useful for isolating one specific incident rather than a class of incidents. See [Field conventions](USAGE.md#field-conventions) in USAGE.md for the full table.

## Why redaction is proportional (75/25), not blanket masking

Blanket masking (`password: '***'`) protects the secret but destroys all signal — you can't tell two different masked tokens apart, which matters when you're trying to confirm "is this the same leaked-looking value we saw in the other event" during an investigation. Proportional masking (75% hidden, last 25% visible, `'***'` outright for anything under 3 characters) keeps enough of the tail visible to recognize or correlate a value without exposing enough to reuse it.

This is also why redaction is the library's own compiled walker rather than pino's built-in `redact` path-list option: pino's option matches wildcards only one level deep and is `O(paths × depth)` per top-level key, which is both the wrong complexity and the wrong matching semantics for catching a secret field nested arbitrarily deep in a request body. The library's walker matches a key name at _any_ depth by default, with exact-chain and mid-chain-wildcard syntax available when you need precision — see [Redaction in practice](USAGE.md#redaction-in-practice) in USAGE.md for the mechanical details and default path list.

## Why the `[APP] ·` message tag

Every message gets a constant three-letter service tag (`[BIL] · Order created`). The tag is _constant per service_ deliberately — Seq groups messages into templates (`@mt`) based on the message string, so if the prefix varied per event (e.g. included a request ID), otherwise-identical messages would never group together and Seq's template view would be useless. A constant tag gives a human scanning a mixed console (multiple services' output interleaved, e.g. in local dev) an instant visual anchor for "which service emitted this" without breaking Seq's grouping for anyone querying centrally.

## Why zero-config auto-detection

A logging library that requires configuration before it produces useful output will, in practice, sometimes not get configured — someone will forget to set `SERVICE_NAME`, and the library needs to degrade gracefully rather than throw or silently omit fields. Service name, version, and instance ID resolve through a fallback chain (explicit option → env var → `package.json`/`os.hostname()` → `'unknown'`) specifically so `createLogger()` with zero arguments produces a fully-formed, if less specific, wide event — with a one-time stderr warning if it had to fall all the way back, so the gap gets noticed without breaking anything.

---

For the complete practical reference — every export, every option, full walkthroughs, common mistakes, and the migration playbook — see [USAGE.md](USAGE.md).
