import { randomUUID } from "node:crypto";
import { withContext, getContext, emitOutcome } from "../context.js";

/**
 * Create Express (or Connect‑compatible) middleware that produces **one wide event**
 * per request.
 *
 * The middleware owns timing, status code, outcome, error capture, and emission.
 * Route handlers call `enrichEvent()` (from `@alexdevuwu/logging`) to add business
 * context — the middleware and the handlers share the same AsyncLocalStorage store,
 * so enrichment lands in the emitted event. Handlers must **not** log directly.
 *
 * An inbound `x-request-id` header is honoured and echoed back on the response;
 * otherwise a fresh UUID is generated.
 *
 * @param {import('pino').Logger} logger - The pino logger instance.
 * @returns {function} Express middleware `(req, res, next) => void`.
 *
 * @example
 * import express from 'express';
 * import { createLogger, enrichEvent } from '@alexdevuwu/logging';
 * import { expressMiddleware } from '@alexdevuwu/logging/express';
 *
 * const { logger } = createLogger({ service: 'billing-api' });
 * const app = express();
 * app.use(expressMiddleware(logger));
 *
 * app.post('/checkout', async (req, res) => {
 *   enrichEvent({ user: { id: req.user.id }, total_cents: 249900 });
 *   res.json({ ok: true });
 * });
 */
export function expressMiddleware(logger) {
  return (req, res, next) => {
    const requestId = req.headers["x-request-id"] || randomUUID();
    res.setHeader("x-request-id", requestId);

    withContext(
      {
        "@request_id": requestId,
        "@method": req.method,
        "@route": req.route?.path || req.path || req.url,
        "@user_agent": req.headers["user-agent"] ?? undefined,
        _startHr: process.hrtime.bigint(),
      },
      (store) => {
        res.once("finish", () => emit(store, res));
        next();
      },
    );

    function emit(store, res) {
      // Use the live ALS store: a handler that called startEvent() replaced the
      // withContext store, and a handler that called endEvent() marked it ended.
      // Falling back to the closure store keeps plain enrichEvent() flows intact.
      const current = getContext() ?? store;
      if (!current || !current._startHr || current._ended) return;

      const durationMs = Math.round(
        Number(process.hrtime.bigint() - current._startHr) / 1e6,
      );
      const statusCode = res.statusCode;
      const outcome =
        statusCode >= 500
          ? "server_error"
          : statusCode >= 400
            ? "client_error"
            : "success";

      const event = {
        ...current,
        "@status_code": statusCode,
        "@duration_ms": durationMs,
        "@outcome": outcome,
      };
      delete event._startHr;
      delete event._ended;

      emitOutcome(logger, event, outcome);
    }
  };
}
