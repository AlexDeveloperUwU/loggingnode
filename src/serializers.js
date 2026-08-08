import pino from "pino";

const stdErr = pino.stdSerializers.err;

/**
 * True when `value` is a plain object that has already been serialised by
 * {@link serializeError} (or matches that shape) — i.e. it carries a `type`
 * marker. pino's own `stdSerializers.err` would otherwise flatten such an object
 * and lose the `type` field on the way to Seq.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSerializedErrorShape(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !(value instanceof Error) &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}

/**
 * pino serializer for the `err` key.
 *
 * Raw `Error` instances go through pino's battle‑tested serializer
 * (`{ type, message, code?, stack }`); already‑serialised error objects pass
 * through untouched so the `type` marker survives to Seq's `@x`.
 *
 * @param {unknown} value
 * @returns {object}
 */
export function errSerializer(value) {
  if (isSerializedErrorShape(value)) return value;
  return stdErr(value);
}

/**
 * pino serializer for the `error` key — same behaviour as {@link errSerializer}.
 * pino‑seq reads both `err` and `error` for its exception mapping.
 *
 * @param {unknown} value
 * @returns {object}
 */
export const errorSerializer = errSerializer;

/**
 * Maximum depth of recursive `cause` serialisation (guards against cycles).
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Produce a uniform wide-event error shape suitable for the `error` field in a
 * canonical log line.
 *
 * Error `cause` chains are serialised recursively (bounded to {@link MAX_CAUSE_DEPTH})
 * so `error.cause` debugging chains survive into the log.
 *
 * @param {unknown} value - An Error instance or any thrown value.
 * @param {number} [depth=0] - Internal recursion guard.
 * @returns {{ type: string, message: string, code?: string, stack?: string, cause?: object }}
 *
 * @example
 * try { throw new TypeError('bad input'); } catch (err) {
 *   endEvent('error', { err: serializeError(err) });
 * }
 *
 * @example
 * // Non-Error values are wrapped:
 * serializeError('oops')
 * // → { type: 'NonErrorThrow', message: 'oops' }
 */
export function serializeError(value, depth = 0) {
  if (value instanceof Error) {
    const obj = {
      type: value.constructor.name,
      message: value.message,
    };
    if (value.code != null) obj.code = String(value.code);
    if (value.stack != null) obj.stack = value.stack;
    if (value.cause != null && depth < MAX_CAUSE_DEPTH) {
      obj.cause = serializeError(value.cause, depth + 1);
    }
    return obj;
  }
  return { type: "NonErrorThrow", message: String(value) };
}
