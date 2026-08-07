/* eslint-disable no-console */
/**
 * Graceful shutdown example — demonstrates `close()` and signal handling.
 *
 *   node examples/shutdown.js
 *
 * Press Ctrl+C to see the shutdown sequence.
 */

import { createLogger } from "@alexdevuwu/logging";

const { logger, close } = createLogger({ service: "shutdown-demo" });

logger.info({ uptime: process.uptime() }, "process started");

// Simulate some work.
let counter = 0;
const timer = setInterval(() => {
  counter += 1;
  logger.info({ counter }, "tick");
}, 1000);

// ── Shutdown handler ──────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal, final_counter: counter }, "shutdown requested");
  clearInterval(timer);

  // Flush pino + pino‑seq batches, with a 5 s timeout so we don't hang
  // forever if the Seq server is unreachable.
  try {
    await Promise.race([
      close(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    console.log("[shutdown] All events flushed.");
  } catch (e) {
    console.error("[shutdown] Error during flush:", e.message);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log("Daemon running — press Ctrl+C to shut down gracefully.");
