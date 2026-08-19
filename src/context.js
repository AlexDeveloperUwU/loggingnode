import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { serializeError } from "./serializers.js";

const als = new AsyncLocalStorage();

/**
 * Default pino level used to emit each `@outcome` value. `server_error`/`error`
 * mean *our* side broke on a request it should have handled — the only cases
 * that default to `error`. `client_error` is a correctly-rejected bad request,
 * not a bug, so it stays at `info` by default.
 *
 * Override per-outcome via `createLogger({ outcomeLevels: { client_error: 'warn' } })`.
 */
export const DEFAULT_OUTCOME_LEVELS = Object.freeze({
  success: "info",
  client_error: "info",
  server_error: "error",
  error: "error",
  unknown: "info",
});

let _logger = null;
let _outcomeLevels = DEFAULT_OUTCOME_LEVELS;

/**
 * True when `outcome` represents a failure on *our* side (as opposed to a
 * correctly-rejected bad request). Drives the emitted message text
 * ("Request completed" vs "Request failed") independently of whatever pino
 * level `outcomeLevels` routes the line to.
 *
 * @param {string} outcome
 * @returns {boolean}
 */
export function isFaultOutcome(outcome) {
  return outcome === "server_error" || outcome === "error";
}

/**
 * Resolve the pino level to emit a given `@outcome` at, honouring any
 * `outcomeLevels` override passed to {@link initRequestContext}. Unknown
 * outcome strings fall back to the fault/non-fault default.
 *
 * @param {string} outcome
 * @returns {'trace'|'debug'|'info'|'warn'|'error'|'fatal'}
 */
export function resolveOutcomeLevel(outcome) {
  return (
    _outcomeLevels[outcome] ?? (isFaultOutcome(outcome) ? "error" : "info")
  );
}

/**
 * Emit `event` on `logger` at the level resolved for `outcome`, with the
 * standard "Request completed"/"Request failed" message. Shared by
 * {@link endEvent} and the Express middleware so both paths stay consistent
 * with a configured `outcomeLevels` override.
 *
 * @param {import('pino').Logger} logger
 * @param {object} event
 * @param {string} outcome
 */
export function emitOutcome(logger, event, outcome) {
  const fault = isFaultOutcome(outcome);
  const level = resolveOutcomeLevel(outcome);
  const message = fault ? "Request failed" : "Request completed";
  const fn =
    typeof logger[level] === "function"
      ? logger[level]
      : logger[fault ? "error" : "info"];
  fn.call(logger, event, message);
}

/**
 * Wire the context module to the active logger.
 * Called by {@link createLogger}. Consumers should never call this directly.
 *
 * @param {object} deps
 * @param {import('pino').Logger} deps.logger
 * @param {Object<string,string>} [deps.outcomeLevels] - Per-outcome pino level
 *   overrides, already validated against real pino levels. Merged over
 *   {@link DEFAULT_OUTCOME_LEVELS}.
 * @internal
 */
export function initRequestContext({ logger, outcomeLevels }) {
  _logger = logger;
  _outcomeLevels = outcomeLevels
    ? { ...DEFAULT_OUTCOME_LEVELS, ...outcomeLevels }
    : DEFAULT_OUTCOME_LEVELS;
}

/**
 * Reset the context module (test seam).
 * @internal
 */
export function resetRequestContext() {
  _logger = null;
  _outcomeLevels = DEFAULT_OUTCOME_LEVELS;
}

/**
 * True when `value` is a plain object (not an array, Date, Error, or class
 * instance) — the only shapes a deep merge recurses into.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMergeable(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Recursively merge `source` into `target`, mutating `target`.
 * Plain objects merge key-by-key; everything else (arrays, primitives, class
 * instances) replaces. `target` is returned for convenience.
 *
 * @param {object} target
 * @param {object} source
 * @returns {object}
 */
function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isMergeable(value) && isMergeable(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
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
 * Merge business fields into the current wide event.
 *
 * Call from route handlers, service methods, etc. to add domain context without
 * emitting a log line. Nested plain objects are deep‑merged (later calls deepen
 * earlier ones); arrays and primitives replace. No‑op when called outside an
 * active event.
 *
 * @param {object} fields
 *
 * @example
 * enrichEvent({ user: { id: req.user.id, subscription: 'enterprise' }, total_cents: 249900 });
 */
export function enrichEvent(fields = {}) {
  const store = als.getStore();
  if (!store) return;
  deepMerge(store, fields);
}

/**
 * Finalise and emit the wide event.
 *
 * Computes `duration_ms` from the internal start time, sets `outcome`, attaches
 * a serialised `error` object when appropriate, removes internal fields, and
 * emits exactly one log line — at the pino level {@link resolveOutcomeLevel}
 * resolves for `outcome` (`info`/`error` by default; configurable per-outcome
 * via `createLogger({ outcomeLevels })`). A second call for the same event is
 * a no‑op, so `endEvent` is safe in both a `catch` and a `finally`.
 *
 * No‑op when called outside an active event or before {@link startEvent}.
 *
 * `outcome` is role-based, not HTTP-only: `client_error` means the *request* was
 * bad (whichever side sent it — an inbound caller or this code's own outbound
 * call to a dependency); `server_error` means the *handler* failed on a valid
 * request (this service, or a downstream dependency this code called). `error`
 * is the catch-all for failures with no request/response shape at all.
 *
 * @param {'success'|'client_error'|'server_error'|'error'|'unknown'} outcome
 * @param {object} [extraFields] - Final fields merged into the event.
 *
 * @example
 * try { await processOrder(); endEvent('success'); }
 * catch (err) { endEvent('error', { err }); throw err; }
 */
export function endEvent(outcome, extraFields = {}) {
  const store = als.getStore();
  if (!store || !store._startHr || store._ended) return;
  store._ended = true;

  const elapsed = process.hrtime.bigint() - store._startHr;
  const durationMs = Math.round(Number(elapsed) / 1e6);

  const event = { ...store, "@outcome": outcome, "@duration_ms": durationMs };
  delete event._startHr;
  delete event._ended;

  const { err, error, ...rest } = extraFields;
  if (err != null || error != null) {
    event["@error"] = serializeError(err ?? error);
  }

  Object.assign(event, rest);

  if (!_logger) return;

  emitOutcome(_logger, event, outcome);
}
