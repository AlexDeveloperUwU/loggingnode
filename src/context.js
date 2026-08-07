import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { serializeError } from "./serializers.js";

const als = new AsyncLocalStorage();

let _logger = null;

/**
 * Wire the context module to the active logger and sampler.
 * Called by {@link createLogger}. Consumers should never call this directly.
 *
 * @param {object} deps
 * @param {import('pino').Logger} deps.logger
 * @param {function} deps.sampler - `(fields) => boolean`
 * @internal
 */
export function initRequestContext({ logger }) {
  _logger = logger;
}

/**
 * Reset the context module (test seam).
 * @internal
 */
export function resetRequestContext() {
  _logger = null;
}

/**
 * Retrieve the current request's event store.
 * Returns `undefined` when called outside a {@link withContext} or `startEvent` scope.
 *
 * @returns {object|undefined}
 */
export function getContext() {
  return als.getStore();
}

/**
 * Run `fn` inside a new AsyncLocalStorage scope seeded with `fields`.
 *
 * Use for non‑HTTP code (workers, cron jobs, queue consumers) where no Express
 * middleware is available. `fn` receives the freshly created store object as its
 * first argument, so callers can hold a reference to it (e.g. to emit an event
 * later, outside the scope).
 *
 * @template T
 * @param {object} fields - Base fields attached to the context.
 * @param {(store: object) => T} fn - Synchronous or async function.
 * @returns {T}
 *
 * @example
 * await withContext({ job: 'nightly-settlement' }, async () => {
 *   startEvent({ job_run_id: run.id });
 *   try { await settle(); endEvent('success'); }
 *   catch (err) { endEvent('error', { err }); throw err; }
 * });
 */
export function withContext(fields, fn) {
  const store = { ...fields };
  return als.run(store, () => fn(store));
}

/**
 * Begin a wide event within the current AsyncLocalStorage context.
 *
 * Generates a `request_id` (`crypto.randomUUID()`) unless one is already present
 * in the store or passed in `fields`. Records a high‑resolution start time for
 * `duration_ms` computation.
 *
 * @param {object} [fields={}] - Initial event fields.
 * @returns {object|undefined} The event store, or `undefined` when called outside a context.
 *
 * @example
 * startEvent({ method: 'POST', route: '/checkout', user_agent: req.headers['user-agent'] });
 */
export function startEvent(fields = {}) {
  const store = als.getStore();
  if (!store) return undefined;

  const event = {
    ...store,
    ...fields,
    "@request_id":
      fields["@request_id"] ??
      fields.request_id ??
      store["@request_id"] ??
      store.request_id ??
      randomUUID(),
    "@timestamp": new Date().toISOString(),
    ...(store._startHr ? {} : { _startHr: process.hrtime.bigint() }),
  };
  als.enterWith(event);
  return event;
}

/**
 * Deep‑merge business fields into the current wide event.
 *
 * Call from route handlers, service methods, etc. to add domain context without
 * emitting a log line. No‑op when called outside an active event.
 *
 * @param {object} fields
 *
 * @example
 * enrichEvent({ user: { id: req.user.id, subscription: 'enterprise' }, total_cents: 249900 });
 */
export function enrichEvent(fields = {}) {
  const store = als.getStore();
  if (!store) return;
  Object.assign(store, fields);
}

/**
 * Finalise and emit the wide event.
 *
 * Computes `duration_ms` from the internal start time, sets `outcome`, attaches
 * a serialised `error` object when appropriate, removes internal fields, runs the
 * sampler, and emits exactly one log line (`info` for success, `error` for failure).
 *
 * No‑op when called outside an active event or before {@link startEvent}.
 *
 * @param {'success'|'error'|'timeout'|'client_error'} outcome
 * @param {object} [extraFields] - Final fields merged into the event.
 *
 * @example
 * try { await processOrder(); endEvent('success'); }
 * catch (err) { endEvent('error', { err }); throw err; }
 */
export function endEvent(outcome, extraFields = {}) {
  const store = als.getStore();
  if (!store || !store._startHr) return;

  const elapsed = process.hrtime.bigint() - store._startHr;
  const durationMs = Math.round(Number(elapsed) / 1e6);

  const event = { ...store, "@outcome": outcome, "@duration_ms": durationMs };
  delete event._startHr;

  const { err, error, ...rest } = extraFields;
  if (err != null || error != null) {
    event["@error"] = serializeError(err ?? error);
  }

  Object.assign(event, rest);

  if (!_logger) return;

  if (outcome === "error" || outcome === "timeout") {
    _logger.error(event, "request failed");
  } else {
    _logger.info(event, "request completed");
  }
}
