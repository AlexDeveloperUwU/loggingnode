# AlexDevUwU.Logging

[![npm version](https://img.shields.io/npm/v/@alexdevuwu/logging.svg)](https://www.npmjs.com/package/@alexdevuwu/logging)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Opinionated structured logging for Node.js services, built on [pino](https://getpino.io/). One wide, context-rich event per request instead of a dozen scattered lines, [Seq](https://datalust.co/seq) aggregation out of the box, sane redaction defaults, and zero build step — pure ESM JavaScript.

The philosophy: **log what happened to the request, not what your code is doing.** Inspired by [loggingsucks.com](https://loggingsucks.com/) and Stripe's canonical log lines.

## Features

- **Wide events** — one canonical log line per request per service, enriched throughout the lifecycle and emitted once at the end
- **Nested operations** — a sub-action with its own independently meaningful outcome (a notification send, a payment call) gets its own correlated child event via `withOperation`, without fragmenting the parent
- **Request correlation** — automatic `@request_id`/`@operation_id`, `x-request-id` header propagation across services
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

logger.info({ order_id: "ord_123", total_cents: 249900 }, "Order created");

const stripe = logger.child({ component: "stripe" });
stripe.warn({ customer_id: "cus_456", attempt: 2 }, "Payment retried");

// On shutdown:
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
  "msg": "[BIL] · Order created"
}
```

Every event automatically carries the environment context (`@service`, `@version`, `@environment`, `@instance_id`) captured once at startup — no per-call repetition. Library-injected fields use the `@` prefix to keep them visually distinct from your own application fields.

## Wide events

A typical request touches 10–20 log statements scattered across middleware, handlers, and clients. Instead, build **one wide event** during the request lifecycle and emit it **once**, in a `finally` block:

```js
import { startEvent, enrichEvent, endEvent } from "@alexdevuwu/logging";

async function handleCheckout(req, res) {
  startEvent({ "@method": req.method, "@route": "/checkout" });
  let outcome = "success";
  try {
    const order = await createOrder(req.body);
    enrichEvent({
      user: { id: req.user.id },
      order_id: order.id,
      total_cents: order.totalCents,
    });
    res.status(201).json(order);
  } catch (err) {
    outcome = "error";
    endEvent(outcome, { err });
    throw err;
  } finally {
    if (outcome === "success") endEvent(outcome);
  }
}
```

The single emitted event carries everything — method, route, outcome, duration, user, order — as one queryable row. With Express, `expressMiddleware` does this automatically and handlers only ever call `enrichEvent`:

```js
import express from "express";
import { createLogger, enrichEvent } from "@alexdevuwu/logging";
import { expressMiddleware } from "@alexdevuwu/logging/express";

const { logger } = createLogger({ service: "billing-api" });
const app = express();
app.use(expressMiddleware(logger)); // one wide event per request

app.post("/checkout", async (req, res) => {
  const order = await createOrder(req.body);
  enrichEvent({ user: { id: req.user.id }, total_cents: order.totalCents });
  res.status(201).json(order);
});
```

Runnable versions of these live in [`examples/`](examples/) — `npm run example:basic` / `example:express` / `example:nested-operations`.

## Documentation

This README is the overview. For everything else:

- **[docs/SPEC.md](docs/SPEC.md)** — the design spec: why the library is shaped this way, argued from first principles (wide events, `withOperation`, redaction, message tags, auto-detection, and more).
- **[docs/USAGE.md](docs/USAGE.md)** — the complete developer guide: every export, every config option and env var, full walkthroughs (Express, non-HTTP, nested operations, outcome semantics, redaction, Seq, shutdown, testing), and a step-ordered migration playbook.

## Development

```bash
npm test                # node --test "test/*.test.js"
npm run test:watch      # node --test --watch "test/*.test.js"
npm run lint             # eslint
npm run format           # prettier
npm run example:basic    # smoke-run the basic example
npm run example:express  # smoke-run the Express example
```

Tests use the built-in `node:test` runner with zero additional dependencies and never require a live Seq server.

## License

[MIT](LICENSE)
