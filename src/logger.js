import pino from "pino";
import { resolveConfig, detectContext } from "./config.js";
import { buildDestinations } from "./streams.js";
import { errSerializer, errorSerializer } from "./serializers.js";
import { buildRedact, createRedactor } from "./redaction.js";
import { initRequestContext } from "./context.js";

let _handle = null;

const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  process.stderr.write(message);
}

const VALID_PINO_LEVELS = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

/**
 * Drop and warn about `outcomeLevels` entries that aren't real pino levels,
 * instead of silently failing to log or throwing at emission time.
 */
function validateOutcomeLevels(outcomeLevels) {
  const valid = {};
  for (const [outcome, level] of Object.entries(outcomeLevels)) {
    if (VALID_PINO_LEVELS.has(level)) {
      valid[outcome] = level;
    } else {
      warnOnce(
        `outcome-level-${outcome}`,
        `[AlexDevUwU.Logging] WARNING: outcomeLevels.${outcome} = "${level}" is not a valid pino level ` +
          `(trace/debug/info/warn/error/fatal) — ignoring override for "${outcome}".\n`,
      );
    }
  }
  return valid;
}

/**
 * First three letters, uppercased; non‑alphanumeric characters stripped;
 * `*`‑padded or `UNK` fallback.
 */
function buildTag(service) {
  const name =
    String(service ?? "")
      .split("/")
      .pop() || "";
  if (!name || name === "unknown") return "UNK";
  const chars = name
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 3)
    .toUpperCase();
  if (!chars) return "UNK";
  return chars.length < 3 ? chars.padEnd(3, "*") : chars;
}

/**
 * Create a configured logger instance.
 *
 * This is the primary entry point. The returned object contains the pino logger
 * plus `flush()` and `close()` helpers that guarantee batched Seq events are
 * drained before the process exits.
 *
 * @param {object} [options={}] - Logger options. See the README for the full table.
 * @returns {{ logger: pino.Logger, flush: () => Promise<void>, close: () => Promise<void> }}
 *
 * @example
 * import { createLogger } from '@alexdevuwu/logging';
 * const { logger, close } = createLogger({ service: 'billing-api' });
 * logger.info({ order_id: 'ord_123' }, 'Order created');
 */
export function createLogger(options = {}) {
  const config = resolveConfig(options, process.env, detectContext());

  if (config.service === "unknown") {
    warnOnce(
      "service-unknown",
      '[AlexDevUwU.Logging] WARNING: no service name found — using "unknown" (message tag [UNK]). ' +
        'Set SERVICE_NAME or add a "name" field to the nearest package.json.\n',
    );
  }
  if (config.pretty && config.environment === "production") {
    warnOnce(
      "prod-pretty",
      "[AlexDevUwU.Logging] WARNING: pretty printing is enabled in production. " +
        "Set LOG_PRETTY=0 or NODE_ENV=production to switch to raw JSON.\n",
    );
  }
  if (
    config.environment === "production" &&
    (config.level === "trace" || config.level === "debug")
  ) {
    warnOnce(
      "prod-verbose",
      `[AlexDevUwU.Logging] WARNING: log level "${config.level}" in production is verbose. ` +
        'Consider "info" or higher.\n',
    );
  }
  const tag = buildTag(config.service);
  const msgPrefix = `[${tag}] · `;

  const redact = createRedactor(
    buildRedact({
      paths: [...config.redact, ...config.redactEnvPaths],
      remove: config.redactRemove,
      censor: config.redactCensor,
    }),
  );

  const { streams, seqStream } = buildDestinations(config);

  const pinoOpts = {
    level: config.level,

    formatters: {
      level: (label) => ({ level: label }),
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    base: {
      "@service": config.service,
      "@version": config.version,
      "@environment": config.environment,
      "@instance_id": config.instanceId,
      "@node_version": config.nodeVersion,
      ...config.base,
    },

    serializers: {
      err: errSerializer,
      error: errorSerializer,
      ...config.serializers,
    },

    hooks: {
      logMethod(args, method) {
        for (let i = 0; i < Math.min(args.length, 2); i++) {
          if (typeof args[i] === "string") {
            args[i] = `${msgPrefix}${args[i]}`;
            break;
          }
        }
        // Deep-redact the merging object and any interpolated objects. The
        // library owns redaction (a single-pass walker) rather than pino's
        // path-list redact, which is O(paths × depth) per top-level key.
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (
            arg !== null &&
            typeof arg === "object" &&
            !(arg instanceof Error)
          ) {
            args[i] = redact(arg);
          }
        }
        return method.apply(this, args);
      },
    },
  };

  let logger;
  if (config.destination) {
    logger = pino(pinoOpts, config.destination);
  } else if (streams.length > 1) {
    logger = pino(pinoOpts, pino.multistream(streams));
  } else {
    logger = pino(pinoOpts, streams[0].stream);
  }

  initRequestContext({
    logger,
    outcomeLevels: validateOutcomeLevels(config.outcomeLevels),
  });

  async function flush() {
    await logger.flush();
    if (seqStream) await seqStream.flush();
  }

  async function close() {
    try {
      await flush();
    } catch (e) {
      process.stderr.write(
        `[AlexDevUwU.Logging] ERROR during flush: ${e.message}\n`,
      );
    }
  }

  return { logger, flush, close };
}

/**
 * Initialise the global singleton logger.
 *
 * Call once at startup (e.g. in `server.js`). Subsequent calls replace the
 * memoised handle — the last `initLogger` wins.
 *
 * @param {object} [options] - Same options as {@link createLogger}.
 * @returns {{ logger: pino.Logger, flush: () => Promise<void>, close: () => Promise<void> }}
 */
export function initLogger(options) {
  _handle = createLogger(options);
  return _handle;
}

/**
 * Retrieve the global singleton logger.
 *
 * **Throws** if {@link initLogger} has never been called — the library never
 * silently creates a default logger from environment variables alone.
 *
 * @returns {pino.Logger}
 * @throws {Error} When `initLogger()` has not been called yet.
 */
export function getLogger() {
  if (!_handle) {
    throw new Error(
      "Logger not initialised — call initLogger(options) or createLogger(options) first.",
    );
  }
  return _handle.logger;
}

/**
 * Reset the global logger. Internal test seam — not part of the public API.
 *
 * @internal
 */
export function resetLogger() {
  _handle = null;
}
