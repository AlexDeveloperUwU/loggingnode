/* eslint-disable no-console */
/**
 * Express middleware example — one wide event per HTTP request.
 *
 *   npm run example:express
 *
 * Requires `express` to be installed (`npm install express`).
 */

import express from "express";
import { createLogger, enrichEvent } from "@alexdevuwu/logging";
import { expressMiddleware } from "@alexdevuwu/logging/express";

const { logger, close } = createLogger({ service: "billing-api" });

const app = express();

// The middleware owns timing, status, outcome, error capture, and emission.
app.use(expressMiddleware(logger));

// ── Routes ────────────────────────────────────────────────────────────────
// Handlers only enrich — they must not log directly.
app.get("/health", (_req, res) => {
  enrichEvent({ health_check: true });
  res.json({ status: "ok" });
});

app.post("/checkout", async (req, res) => {
  // Simulate user authentication.
  const user = { id: "u_42", subscription: "enterprise", accountAgeDays: 640 };
  enrichEvent({ user });

  // Simulate order processing.
  const order = { id: "ord_FX29", totalCents: 249900 };
  enrichEvent({ order_id: order.id, total_cents: order.totalCents });

  res.status(201).json(order);
});

app.get("/error", (_req, _res) => {
  throw new Error("simulated failure — notice the wide event is still emitted");
});

// ── Error handler ─────────────────────────────────────────────────────────
// The middleware's finish handler fires even on errors, so the wide event
// still gets emitted with `outcome: 'error'`.  This handler just sends the
// HTTP response.
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────
const server = app.listen(0, () => {
  const { port } = server.address();
  console.log(`Listening on http://localhost:${port}`);
  console.log("Try:");
  console.log(`  curl -v http://localhost:${port}/health`);
  console.log(`  curl -v -X POST http://localhost:${port}/checkout`);
  console.log(`  curl -v http://localhost:${port}/error`);
  console.log("Press Ctrl+C to stop.");
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, "Shutdown requested");
  server.close();
  await close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
