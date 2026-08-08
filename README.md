# AlexDevUwU.Logging

[![npm version](https://img.shields.io/npm/v/@alexdevuwu/logging.svg)](https://www.npmjs.com/package/@alexdevuwu/logging)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Opinionated structured logging for Node.js services, built on [pino](https://getpino.io/). One wide, context-rich event per request instead of a dozen scattered lines, [Seq](https://datalust.co/seq) aggregation out of the box, sane redaction defaults, and zero build step — pure ESM JavaScript.

The philosophy: **log what happened to the request, not what your code is doing.** Inspired by [loggingsucks.com](https://loggingsucks.com/) and Stripe's canonical log lines.

## Features

- **Wide events** — one canonical log line per request per service, enriched throughout the lifecycle and emitted once at the end
- **Request correlation** — automatic `@request_id` (`crypto.randomUUID()` fallback), `x-request-id` header propagation across services
- **AsyncLocalStorage context** — enrich the current request's event from anywhere in the call stack, no parameter threading
- **Dual output** — pretty-printed console in development, single-line JSON to stdout in production, and batched Seq ingestion whenever `SEQ_SERVER_URL` is set
- **Secure by default** — passwords, tokens, cookies, API keys, and card data are proportionally masked (75% hidden, last 25% shown) before they ever reach a log stream
- **Self-describing services** — `@service`, `@version`, and `@instance_id` are auto-detected from `package.json` and the hostname; zero-config for the common case
- **Uniform message format** — every message is prefixed `[APP] · ` with your app's three-letter tag, so the source service is visible at a glance in any console
- **Environment-based configuration** — twelve-factor friendly; explicit options override env vars, env vars override defaults
- **Full Seq support** — message templates (`@mt`), context dictionaries, batching controls; every `pino-seq`/`seq-logging` option passes through
- **Framework-agnostic** — works in web apps, CLIs, workers, cron jobs, and queue consumers; the Express middleware is an optional subpath import
- **Graceful shutdown** — `flush()` / `close()` guarantee buffered Seq batches are delivered before exit
- **Pure ESM, zero test deps** — `"type": "module"`, no transpilation, tests run on the built-in `node:test` runner

## Requirements

- Node.js **>= 18** (>= 20 recommended)
- Optional: a [Seq](https://datalust.co/seq) server for centralized aggregation

## Installation

```bash
npm install @alexdevuwu/logging
```

For pretty-printed logs in development, also install `pino-pretty` (optional peer dependency — production installs don't need it):

```bash
npm install --save-dev pino-pretty
```

## Quick start

```js
import { createLogger } from "@alexdevuwu/logging";

const { logger, close } = createLogger({ service: "billing-api" });

logger.info({ order_id: "ord_123", total_cents: 249900 }, "order created");

const stripe = logger.child({ component: "stripe" });
stripe.warn({ customer_id: "cus_456", attempt: 2 }, "payment retried");

// On shutdown (see Graceful shutdown):
await close();
```

Output (production):

```json
{
  "level": "info",
  "time": "2026-08-03T19:00:00.000Z",
  "@service": "billing-api",
  "@version": "1.4.2",
  "@environment": "production",
  "@instance_id": "web-1",
  "order_id": "ord_123",
  "total_cents": 249900,
  "msg": "[BIL] · order created"
}
```

Every event automatically carries the environment context (`@service`, `@version`, `@environment`, `@instance_id`) captured once at startup — no per-call repetition.

> **Field namespacing:** Library-injected fields use the `@` prefix (e.g. `@service`, `@request_id`, `@duration_ms`) to keep them visually distinct from your application's own fields. Following [Seq's convention](https://docs.datalust.co/docs/posting-raw-events), `@` marks them as system metadata. Your fields stay prefix-free — just use plain `snake_case`.

## Message format

Every log message is automatically prefixed with your app's three-letter tag:

```
[BIL] · order created
```

The tag is derived from the service name: first three letters, uppercased. Short names are padded with `*` to always fill the three slots (`ap` → `AP*`, `x` → `X**`); when no service name can be determined the tag is `UNK`. The prefix is constant per service, so Seq's message-template grouping is unaffected.

## Wide events (the point of this library)

A typical request touches 10–20 log statements scattered across middleware, handlers, and clients — none of which carries enough context to debug an incident. Instead, build **one wide event** during the request lifecycle and emit it **once**, in a `finally` block, so it's complete even on failure:

```js
import { startEvent, enrichEvent, endEvent } from "@alexdevuwu/logging";

async function handleCheckout(req, res) {
  startEvent({
    "@request_id": req.headers["x-request-id"], // honored if present, else a UUID is generated
    "@method": req.method,
    "@route": "/checkout",
    "@user_agent": req.headers["user-agent"],
  });

  let outcome = "success";
  try {
    const order = await createOrder(req.body);

    // Handlers only enrich — they never log:
    enrichEvent({
      user: {
        id: req.user.id,
        subscription: req.user.tier,
        account_age_days: req.user.accountAgeDays,
      },
      order_id: order.id,
      total_cents: order.totalCents,
      feature_flags: { new_payment_flow: true },
    });

    res.status(201).json(order);
  } catch (err) {
    outcome = "error";
    endEvent(outcome, { err }); // uniform error object: { type, message, code, stack }
    throw err;
  } finally {
    if (outcome === "success") endEvent(outcome);
  }
}
```

The single emitted event:

```json
{
  "level": "info",
  "@request_id": "b3f1c2...",
  "@method": "POST",
  "@route": "/checkout",
  "@status_code": 201,
  "@outcome": "success",
  "@duration_ms": 87,
  "user": {
    "id": "u_42",
    "subscription": "enterprise",
    "account_age_days": 640
  },
  "order_id": "ord_123",
  "total_cents": 249900,
  "feature_flags": { "new_payment_flow": true },
  "@service": "billing-api",
  "msg": "[BIL] · request completed"
}
```

Now "show me failed checkouts for enterprise customers with `new_payment_flow` enabled, grouped by error code" is a one-line analytics query, not an afternoon of `grep`.

## Express middleware

The middleware owns timing, status code, outcome, error capture, and emission. Your handlers only enrich:

```js
import express from "express";
import { createLogger, enrichEvent } from "@alexdevuwu/logging";
import { expressMiddleware } from "@alexdevuwu/logging/express";

const { logger } = createLogger({ service: "billing-api" });
const app = express();

app.use(expressMiddleware(logger)); // one wide event per request, emitted on res 'finish'

app.post("/checkout", async (req, res) => {
  const order = await createOrder(req.body);
  enrichEvent({
    user: { id: req.user.id, subscription: req.user.tier },
    total_cents: order.totalCents,
  });
  res.status(201).json(order);
});
```

An inbound `x-request-id` header is honored (and echoed back on the response); otherwise a fresh UUID is generated. Forward the value from `@request_id` as `x-request-id` on outbound calls to keep distributed flows reconstructible.

## Outside web applications (CLI, workers, cron, queues)

The core library has **no HTTP dependency** — not everything is a web app. The Express middleware is an optional subpath import; CLI tools, background workers, cron jobs, and queue consumers use the exact same logger and wide-event API. Wrap any unit of work in `withContext` to get the same correlation and enrichment:

```js
import {
  withContext,
  startEvent,
  enrichEvent,
  endEvent,
} from "@alexdevuwu/logging";

await withContext(
  { job: "nightly-settlement", job_run_id: run.id },
  async () => {
    startEvent({ "@job": "nightly-settlement" });
    try {
      const result = await settle();
      enrichEvent({
        settled_count: result.count,
        total_cents: result.totalCents,
      });
      endEvent("success");
    } catch (err) {
      endEvent("error", { err });
      throw err;
    }
  },
);
```

> **Caveat:** libraries that break async context propagation (pooled callbacks, cached event emitters) can silently drop enrichment. `startEvent` also returns the event object, so you can thread it manually in those rare cases.

## Configuration

`createLogger(options)` — explicit options **override** environment variables, which **override** defaults.

### Options

| Option                     | Type               | Default                                      | Description                                                                                        |
| -------------------------- | ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `service`                  | string             | auto-detected (see below)                    | Service name → `@service`; source of the `[APP]` message tag                                       |
| `level`                    | string             | `LOG_LEVEL` or `info` (prod) / `debug` (dev) | Minimum pino level: `trace`/`debug`/`info`/`warn`/`error`/`fatal`                                  |
| `environment`              | string             | `NODE_ENV` or `'development'`                | → `@environment` base field                                                                        |
| `version`                  | string             | auto-detected                                | Deployed version → `@version`                                                                      |
| `instanceId`               | string             | auto-detected                                | → `@instance_id`                                                                                   |
| `pretty`                   | boolean            | `true` unless production                     | Pretty-print to stdout (requires `pino-pretty`)                                                    |
| `seq`                      | object             | enabled iff `serverUrl` set                  | Seq stream config, see below                                                                       |
| `seq.serverUrl`            | string             | `SEQ_SERVER_URL`                             | Seq ingestion endpoint, e.g. `http://localhost:5341`                                               |
| `seq.apiKey`               | string             | `SEQ_API_KEY`                                | Optional Seq API key                                                                               |
| `seq.maxBatchingTime`      | number             | pino-seq default                             | Max ms a batch is held before sending                                                              |
| `seq.eventSizeLimit`       | number             | pino-seq default                             | Per-event byte cap                                                                                 |
| `seq.batchSizeLimit`       | number             | pino-seq default                             | Per-batch byte cap                                                                                 |
| `seq.onError`              | function           | stderr                                       | Delivery-failure handler — never log inside it (recursion)                                         |
| `seq.additionalProperties` | object             | —                                            | Context dictionary attached to every Seq event                                                     |
| `seq.logOtherAs`           | string             | —                                            | Seq level for unstructured (non-JSON) output: `'Verbose'`…`'Fatal'`                                |
| `seq.*`                    | any                | —                                            | Any other [`seq-logging`](https://github.com/datalust/seq-logging) option passes through untouched |
| `seqLevel`                 | string             | `'info'` (dev) / `'warn'` (prod)             | Minimum level routed to Seq                                                                        |
| `redact`                   | string[]           | —                                            | Extra redaction paths, union-merged with the defaults                                              |
| `redactRemove`             | string[]           | —                                            | Deliberately remove default redaction paths                                                        |
| `redactCensor`             | string \| function | proportional mask (see Redaction)            | Replacement value, or `(value, path) => string` for full control                                   |
| `base`                     | object             | —                                            | Extra pino `base` fields merged into every event                                                   |
| `serializers`              | object             | —                                            | Extra pino serializers merged over the defaults                                                    |
| `destination`              | Writable           | —                                            | Inject a custom destination (test seam); bypasses stream assembly                                  |
| `stdoutAsync`              | boolean            | `true`                                       | Use `pino.destination({ sync: false })` for stdout in production                                   |

### Auto-detection

Most context fills itself in — set options only when auto-detection isn't enough:

| Field          | Resolution order                                                                    |
| -------------- | ----------------------------------------------------------------------------------- |
| `@service`     | option → `SERVICE_NAME` → nearest `package.json` `name` → `'unknown'` (tag `[UNK]`) |
| `@version`     | option → `SERVICE_VERSION` → nearest `package.json` `version` → `'unknown'`         |
| `@instance_id` | option → `HOSTNAME` → `os.hostname()` → random UUID                                 |
| `@environment` | option → `NODE_ENV` → `'development'`                                               |

`@node_version` (`process.version`) is always included in the base fields as well.

### Environment variables

| Variable                   | Default                           | Purpose                                                 |
| -------------------------- | --------------------------------- | ------------------------------------------------------- |
| `SERVICE_NAME`             | auto-detected from `package.json` | Service name (used when the `service` option is absent) |
| `LOG_LEVEL`                | `info` (prod) / `debug` (dev)     | Minimum log level                                       |
| `NODE_ENV`                 | `development`                     | Environment; drives pretty/level defaults               |
| `SERVICE_VERSION`          | `unknown`                         | `@version` base field                                   |
| `HOSTNAME`                 | random UUID                       | `@instance_id` base field                               |
| `SEQ_SERVER_URL`           | —                                 | Enables the Seq stream when set                         |
| `SEQ_API_KEY`              | —                                 | Seq API key                                             |
| `LOG_PRETTY`               | on unless production              | `1`/`true`/`0`/`false`                                  |
| `LOG_REDACT_PATHS`         | —                                 | Comma-separated extra redaction paths                   |
| `SEQ_MAX_BATCHING_TIME_MS` | pino-seq default                  | Seq batching window                                     |
| `SEQ_EVENT_SIZE_LIMIT`     | pino-seq default                  | Per-event byte cap                                      |
| `SEQ_BATCH_SIZE_LIMIT`     | pino-seq default                  | Per-batch byte cap                                      |

Validation never crashes your app over configuration: if no service name can be found anywhere, the service falls back to `'unknown'` (message tag `[UNK]`) with a one-time stderr warning — name your service. Production combined with pretty printing or `trace`/`debug` levels also emits a one-time stderr warning.

## Log levels — guidance

All pino levels are available, but the library is designed around a simpler discipline:

- **`info`** — wide events and significant lifecycle moments (startup, shutdown, migrations)
- **`error`** — unexpected failures, always with a serialized `err`
- **`debug`/`trace`** — local development noise; assume they're disabled in production
- **`warn`** — sparingly; a warning nobody acts on is noise

If you reach for `debug` to understand a request, add fields to the wide event instead — you'll have them in production too.

## Field conventions

Consistent field names are what make cross-service queries possible:

| Convention                | Examples                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| snake_case everywhere     | `@request_id`, `@status_code`, `@user_agent`                                              |
| Unit suffixes             | `@duration_ms`, `@latency_ms`, `total_cents`, `lifetime_value_cents`                      |
| Money in minor units      | `249900` not `2499.00`                                                                    |
| Nested objects per domain | `user: { id, subscription }`, `cart: { ... }`, `payment: { ... }`                         |
| Outcome enum              | `@outcome: 'success' \| 'error' \| 'timeout' \| 'client_error'`                           |
| Uniform error shape       | `@error: { type, message, code, stack, cause? }` (cause chains serialised, depth-bounded) |
| ISO-8601 UTC timestamps   | `@timestamp` (`2026-08-03T19:00:00.000Z`, automatic)                                      |

High cardinality is a feature: `@request_id`, `user_id`, and order IDs belong in your events. Modern log stores index them cheaply, and they're what make logs actually debuggable.

## Redaction

Sensitive fields are masked before serialization. Masking is **proportional to the value's length**, computed per value, so you keep enough signal to recognize or correlate a leaked-adjacent value without exposing it:

- Values shorter than 3 characters → always `***`
- Otherwise 75% of the characters are replaced with `*` and the **last 25%** stay visible

```
'ab'           → '***'
'supersecret'  → '********ret'
```

Default paths covered — each secret name is matched **at any nesting depth** (not just one level), plus explicit `headers.*` variants:

`password`, `passwd`, `secret`, `authorization`, `x-api-key`, `cookie`, `set-cookie`, `token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apiKey`, `private_key`, `credit_card`, `card_number`, `cvv`, `ssn`

```js
const { logger } = createLogger({
  service: "billing-api",
  redact: ["session_id", "*.session_id"], // add paths
  redactRemove: ["token"], // deliberately remove a default (be sure!)
});

// The default censor is the proportional 75/25 mask. Replace it with a fixed
// string, or a function `(value, path) => string` for full control:
const { logger: strict } = createLogger({
  service: "billing-api",
  redactCensor: "***",
});
const { logger: custom } = createLogger({
  service: "billing-api",
  redactCensor: (value, path) =>
    `${value}`.slice(-4).padStart(`${value}`.length, "*"),
});
```

**How it works.** Redaction is the library's own single-pass walker (not pino's path-list `redact`, which is O(paths × depth) per top-level key and only matches one wildcard level). It runs before serialization, never mutates your objects, and skips branches that contain no match — events without sensitive fields pass through with zero allocation. Path semantics:

- `password` / `*.password` — match the key at **any** depth
- `headers.authorization` / `headers["x-api-key"]` — exact chain from the root (bracket notation supported)
- `req.*.authorization` — `*` matches any single key in the chain

`redactRemove` removes a name **and every variant of it** (`token` also removes `*.token`, `headers["set-cookie"]`-style entries with the same leaf name). It exists as an explicit escape hatch — removing a default should always be a conscious, reviewable decision.

## Seq setup

Run Seq locally:

```bash
docker run --name seq -d --restart unless-stopped -e ACCEPT_EULA=Y -p 5341:80 datalust/seq:latest
```

Then point the library at it:

```bash
export SEQ_SERVER_URL=http://localhost:5341
# export SEQ_API_KEY=...  # if your Seq instance requires one
```

Events arrive with proper Seq semantics: `msg` becomes the message template (`@mt`), so identical messages group together — which is exactly why you should pass data as **fields**, never string-interpolate it into the message. Serialized errors become Seq exceptions (`@x`). All event fields arrive as a fully queryable property dictionary.

**Full Seq feature support.** Everything `pino-seq`/`seq-logging` offers is available through the `seq` option: message templating, context dictionaries via `seq.additionalProperties`, batching controls (`maxBatchingTime`, `eventSizeLimit`, `batchSizeLimit`), `logOtherAs` for capturing unstructured output, and API-key authentication. Any option the underlying `seq-logging` client accepts is passed through untouched — the library never hides Seq functionality from you.

pino levels map to Seq levels:

| pino         | Seq         |
| ------------ | ----------- |
| `trace` (10) | Verbose     |
| `debug` (20) | Debug       |
| `info` (30)  | Information |
| `warn` (40)  | Warning     |
| `error` (50) | Error       |
| `fatal` (60) | Fatal       |

In development you'll get pretty console output **and** Seq ingestion simultaneously when `SEQ_SERVER_URL` is set — a convenient way to validate your Seq pipeline locally.

## Graceful shutdown

pino-seq batches events before sending. Calling `process.exit()` without flushing **discards buffered batches**. Always close the logger on shutdown:

```js
import { createLogger } from "@alexdevuwu/logging";

const { logger, close } = createLogger({ service: "billing-api" });

async function shutdown(signal) {
  logger.info({ signal }, "shutdown requested");
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

`close()` is idempotent and never throws — flush failures are reported on stderr. (SIGKILL/SIGSEGV can't be trapped; that's what the batching window bounds.)

## Anti-patterns this library exists to prevent

- **`console.log`** — unstructured, unlevelled, unqueryable, uncorrelated
- **Per-file logger instances** — configure once, use `logger.child({ component })` instead
- **String interpolation** — `logger.info(\`order ${id} failed\`)`destroys Seq's template grouping; use fields:`logger.info({ order_id: id }, 'order failed')`
- **Scattered lines per request** — ten partial lines are worse than one wide event; enrich, don't log
- **Missing request correlation** — every event carries `@request_id`; propagate `x-request-id` across service hops
- **Logging secrets** — default redaction covers the common cases; extend it when you add a new secret-bearing field

## Development

```bash
npm test                # node --test "test/*.test.js"
npm run test:watch      # node --test --watch "test/*.test.js"
npm run lint            # eslint
npm run format          # prettier
npm run example:basic   # smoke-run the basic example
npm run example:express # smoke-run the Express example
```

Tests use the built-in `node:test` runner with zero additional dependencies and never require a live Seq server.

## License

[MIT](LICENSE)
