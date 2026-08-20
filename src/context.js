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

/** Soft cap on `@child_operations` entries per event — see {@link withOperation}. */
const MAX_CHILD_OPERATIONS = 50;

const _warned = new Set();
/**
 * Emit `message` to stderr the first time this `key` is seen, silently
 * no-op on repeats. Local copy of the same shape used in `logger.js` —
 * importing it from there would create a `logger.js` ↔ `context.js` cycle,
 * since `logger.js` already imports {@link initRequestContext} from here.
 */
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  process.stderr.write(message);
}

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
 * standard "Request completed"/"Request failed" ("Operation ..." for a
 * {@link withOperation} child, detected from `event["@parent_operation_id"]`
 * being present) message. Shared by {@link endEvent}, {@link withOperation},
 * and the Express middleware so all three stay consistent with a configured
 * `outcomeLevels` override.
 *
 * @param {import('pino').Logger} logger
 * @param {object} event
 * @param {string} outcome
 */
export function emitOutcome(logger, event, outcome) {
  const fault = isFaultOutcome(outcome);
  const level = resolveOutcomeLevel(outcome);
  const noun = event["@parent_operation_id"] ? "Operation" : "Request";
  const message = fault ? `${noun} failed` : `${noun} completed`;
  const fn =
    typeof logger[level] === "function"
      ? logger[level]
      : logger[fault ? "error" : "info"];
  fn.call(logger, event, message);
}

/**
 * Validate `outcome` against {@link DEFAULT_OUTCOME_LEVELS}'s keys — the
 * canonical list of valid outcomes. Falls back to `"unknown"` with a
 * one-time stderr warning instead of logging a typo'd value verbatim.
 *
 * @param {string} outcome
 * @returns {string}
 */
function normalizeOutcome(outcome) {
  if (Object.hasOwn(DEFAULT_OUTCOME_LEVELS, outcome)) return outcome;
  warnOnce(
    "invalid-outcome",
    `[AlexDevUwU.Logging] WARNING: invalid outcome "${outcome}" — falling back to "unknown". ` +
      `Valid values: ${Object.keys(DEFAULT_OUTCOME_LEVELS).join(", ")}.\n`,
  );
  return "unknown";
}

/**
 * Build the final emittable event from a store: normalizes `outcome`,
 * computes `@duration_ms`, attaches a serialized `@error` when `err`/`error`
 * is present in `extraFields`, and strips internal bookkeeping fields.
 * Shared by {@link endEvent} and {@link withOperation}.
 *
 * @param {object} store
 * @param {string} outcome
 * @param {object} extraFields
 * @returns {{ event: object, outcome: string }}
 */
function buildOutcomeEvent(store, outcome, extraFields) {
  const normalized = normalizeOutcome(outcome);
  const elapsed = process.hrtime.bigint() - store._startHr;
  const durationMs = Math.round(Number(elapsed) / 1e6);

  const event = {
    ...store,
    "@outcome": normalized,
    "@duration_ms": durationMs,
  };
  delete event._startHr;
  delete event._ended;
  delete event._ownedByOperation;

  const { err, error, ...rest } = extraFields;
  if (err != null || error != null) {
    event["@error"] = serializeError(err ?? error);
  }

  Object.assign(event, rest);

  return { event, outcome: normalized };
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
 * Generates a `request_id` (`crypto.randomUUID()`) and an `@operation_id`
 * unless one is already present in the store or passed in `fields`. Records
 * a high‑resolution start time for `duration_ms` computation.
 *
 * Calling this while already inside an active, un-ended event (e.g. nested
 * inside another `startEvent`/`withOperation` scope) is a safety net, not
 * the sanctioned pattern for nested work — see {@link withOperation}. In
 * that case `fields` is merged into the existing event (like `enrichEvent`)
 * instead of resetting it, with a one-time stderr warning.
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

  if (store._startHr && !store._ended) {
    warnOnce(
      "nested-start-event",
      "[AlexDevUwU.Logging] WARNING: startEvent() called while an event is already active — " +
        "merging fields into it instead of resetting it. Use withOperation() to track a nested " +
        "sub-action as its own correlated event.\n",
    );
    deepMerge(store, fields);
    return store;
  }

  const event = {
    ...store,
    ...fields,
    "@operation_id":
      fields["@operation_id"] ?? store["@operation_id"] ?? randomUUID(),
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

  if (store._ownedByOperation) {
    warnOnce(
      "end-event-inside-with-operation",
      "[AlexDevUwU.Logging] WARNING: endEvent() called inside a withOperation() callback — " +
        "ignored. The operation's outcome is determined automatically by whether the " +
        "callback returns or throws; call enrichEvent() instead if you just want to add fields.\n",
    );
    return;
  }

  store._ended = true;
  const { event, outcome: normalized } = buildOutcomeEvent(
    store,
    outcome,
    extraFields,
  );

  if (!_logger) return;

  emitOutcome(_logger, event, normalized);
}

/**
 * Track a nested sub-action as its own correlated wide event, safely under
 * concurrency.
 *
 * Use this — not a nested `startEvent()` — for a sub-action whose own
 * success or failure is independently meaningful and worth querying/
 * alerting on separately from the parent event (a notification send, a
 * payment call, an LLM call, a third-party API call). It is not a
 * general-purpose wrapper for every internal function or DB call — wrapping
 * everything in `withOperation` reintroduces the scattered-lines problem
 * wide events exist to prevent; reach for `enrichEvent` for anything that
 * doesn't need its own row.
 *
 * Runs `fn` inside its own `AsyncLocalStorage.run()` scope (not
 * `enterWith`), so it's safe even when multiple `withOperation` calls run
 * concurrently under the same parent (e.g. via `Promise.all`) — each gets
 * an isolated child event and the parent's context is automatically
 * restored once `fn` settles, regardless of ordering.
 *
 * The child event gets its own `@operation_id`, a `@parent_operation_id`
 * pointing at the parent's own `@operation_id`, and the parent's shared
 * `@request_id`. It's finalized and emitted as its own log line
 * ("Operation completed"/"Operation failed") the moment `fn` returns or
 * throws — outcome is always exactly that, never something a stray
 * `endEvent()` call inside `fn` can override. The parent event's
 * `@child_operations` array gets an entry `{ operation_id, name }` as this
 * starts, backfilled with `duration_ms`/`outcome` once it finishes — capped
 * at 50 entries, with `@child_operations_truncated` counting the rest, so a
 * loop that fans out many operations can't grow the parent event
 * unboundedly.
 *
 * No-op passthrough (runs `fn` untracked) when called outside any active
 * context.
 *
 * @template T
 * @param {string} name - Short, stable name for this operation (e.g. `'send-warning'`).
 * @param {object|(store: object) => Promise<T>} [fields] - Initial fields for the child
 *   event, or the callback itself if no fields are needed.
 * @param {(store: object) => Promise<T>} [fn] - The operation's work. Receives the child event store.
 * @returns {Promise<T>}
 *
 * @example
 * async function sendWarning(userId) {
 *   return withOperation('send-warning', { user_id: userId }, async () => {
 *     await notificationService.send(userId, 'content-warning');
 *   });
 * }
 */
export async function withOperation(name, fields, fn) {
  if (typeof fields === "function") {
    fn = fields;
    fields = {};
  }

  const parentStore = als.getStore();
  if (!parentStore) return fn();

  const operationId = randomUUID();
  const parentOperationId = parentStore["@operation_id"];
  const requestId =
    parentStore["@request_id"] ?? parentStore.request_id ?? randomUUID();

  // INVARIANT: this push must stay synchronous, before any `await` below —
  // that's what makes it safe under concurrent siblings sharing parentStore.
  // Do not move it after als.run()/the first await.
  const childEntry = { operation_id: operationId, name };
  const siblings = (parentStore["@child_operations"] ??= []);
  if (siblings.length < MAX_CHILD_OPERATIONS) {
    siblings.push(childEntry);
  } else {
    parentStore["@child_operations_truncated"] =
      (parentStore["@child_operations_truncated"] ?? 0) + 1;
    warnOnce(
      "child-operations-truncated",
      `[AlexDevUwU.Logging] WARNING: more than ${MAX_CHILD_OPERATIONS} child operations on ` +
        "one event — further children still run and emit their own event, but stop being " +
        "listed in @child_operations. withOperation is meant for a handful of meaningful " +
        "sub-actions per request, not a loop body.\n",
    );
  }

  const childStore = {
    ...parentStore,
    ...fields,
    "@operation_id": operationId,
    "@request_id": requestId,
    "@timestamp": new Date().toISOString(),
    _startHr: process.hrtime.bigint(),
    _ownedByOperation: true,
  };
  delete childStore["@child_operations"];
  delete childStore["@child_operations_truncated"];
  delete childStore._ended;
  if (parentOperationId) childStore["@parent_operation_id"] = parentOperationId;

  function finish(outcome, extraFields) {
    childStore._ended = true;
    const { event, outcome: normalized } = buildOutcomeEvent(
      childStore,
      outcome,
      extraFields,
    );
    Object.assign(childEntry, {
      duration_ms: event["@duration_ms"],
      outcome: normalized,
    });
    if (_logger) emitOutcome(_logger, event, normalized);
  }

  try {
    const result = await als.run(childStore, () => fn(childStore));
    finish("success", {});
    return result;
  } catch (err) {
    finish("error", { err });
    throw err;
  }
}
