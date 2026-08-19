import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const pkgCache = new Map();

/**
 * Walk up from `start` to find the nearest `package.json`, parse it, and return
 * its `name` and `version` fields. Returns `null` when no `package.json` is found
 * within 20 directory levels. Result is memoised per starting directory — the
 * filesystem doesn't change under a running process.
 *
 * @param {string} start - Directory to begin the walk from.
 * @returns {{ name?: string, version?: string } | null}
 */
function readNearestPackageJson(start) {
  if (pkgCache.has(start)) return pkgCache.get(start);

  let dir = start;
  let found = null;
  for (let i = 0; i < 20; i++) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf-8");
      const pkg = JSON.parse(raw);
      found = {
        name: pkg.name ?? undefined,
        version: pkg.version ?? undefined,
      };
      break;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  pkgCache.set(start, found);
  return found;
}

/**
 * Detect the environment-derived context for a service.
 *
 * This is the only impure entry point — it reads `package.json` (from `start`
 * upward) and the OS hostname. Call it once and pass the result into the pure
 * {@link resolveConfig} as the `detected` argument.
 *
 * @param {string} [start=process.cwd()] - Directory to search for `package.json`.
 * @returns {{ pkg: { name?: string, version?: string } | null, hostname: string }}
 */
export function detectContext(start = process.cwd()) {
  return { pkg: readNearestPackageJson(start), hostname: hostname() };
}

/**
 * Build the Seq stream configuration from options and environment variables.
 * Returns `undefined` when no Seq server URL is configured.
 *
 * @param {object|undefined} seqOpts - The `seq` option object from `createLogger`.
 * @param {Record<string,string|undefined>} env
 * @returns {object|undefined}
 */
function buildSeqConfig(seqOpts = {}, env) {
  const serverUrl = seqOpts.serverUrl || env.SEQ_SERVER_URL;
  if (!serverUrl) return undefined;

  const config = { serverUrl };

  const apiKey = seqOpts.apiKey || env.SEQ_API_KEY;
  if (apiKey) config.apiKey = apiKey;

  const maxBatchingTime = toFiniteNumber(env.SEQ_MAX_BATCHING_TIME_MS);
  if (maxBatchingTime != null) config.maxBatchingTime = maxBatchingTime;
  const eventSizeLimit = toFiniteNumber(env.SEQ_EVENT_SIZE_LIMIT);
  if (eventSizeLimit != null) config.eventSizeLimit = eventSizeLimit;
  const batchSizeLimit = toFiniteNumber(env.SEQ_BATCH_SIZE_LIMIT);
  if (batchSizeLimit != null) config.batchSizeLimit = batchSizeLimit;

  if (seqOpts.maxBatchingTime != null)
    config.maxBatchingTime = Number(seqOpts.maxBatchingTime);
  if (seqOpts.eventSizeLimit != null)
    config.eventSizeLimit = Number(seqOpts.eventSizeLimit);
  if (seqOpts.batchSizeLimit != null)
    config.batchSizeLimit = Number(seqOpts.batchSizeLimit);
  if (seqOpts.onError) config.onError = seqOpts.onError;
  if (seqOpts.additionalProperties)
    config.additionalProperties = seqOpts.additionalProperties;
  if (seqOpts.logOtherAs) config.logOtherAs = seqOpts.logOtherAs;

  const known = new Set([
    "serverUrl",
    "apiKey",
    "maxBatchingTime",
    "eventSizeLimit",
    "batchSizeLimit",
    "onError",
    "additionalProperties",
    "logOtherAs",
  ]);
  for (const [k, v] of Object.entries(seqOpts)) {
    if (!known.has(k) && v != null) config[k] = v;
  }

  return config;
}

/**
 * Resolve the first defined, non‑empty value from a list of candidates.
 * `false` and `0` are valid candidates — only `null`, `undefined`, and `''` are skipped.
 *
 * @param {...(string|number|boolean|undefined|null)} values
 * @returns {*}
 */
function firstOf(...values) {
  for (const v of values) {
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/**
 * Parse the `LOG_PRETTY` env var to a boolean, or return `undefined` when absent.
 *
 * @param {string|undefined} raw
 * @returns {boolean|undefined}
 */
function parsePrettyEnv(raw) {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return undefined;
}

/**
 * Parse a numeric env var, returning `undefined` for garbage so unvalidatable
 * values silently fall back to the underlying default instead of poisoning the
 * seq-logging client with `NaN`.
 *
 * @param {string|undefined} raw
 * @returns {number|undefined}
 */
function toFiniteNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve and normalise all configuration.
 *
 * Precedence: **explicit option → environment variable → detected context → built‑in default**.
 * Pure: any value read from the outside world (filesystem, OS) must come in via the
 * `detected` argument from {@link detectContext}. Returns a frozen object — callers
 * should treat it as read‑only.
 *
 * @param {object} [options={}]
 * @param {Record<string,string|undefined>} [env={}] - Environment (injectable for testing).
 * @param {object} [detected={}] - Output of {@link detectContext}.
 * @param {{ name?: string, version?: string } | null} [detected.pkg] - Nearest package.json metadata.
 * @param {string} [detected.hostname] - OS hostname.
 * @returns {object} A frozen config object.
 */
export function resolveConfig(options = {}, env = {}, detected = {}) {
  const pkg = detected.pkg ?? null;
  const host = detected.hostname ?? null;

  const environment = firstOf(options.environment, env.NODE_ENV, "development");
  const isProduction = environment === "production";

  const service = firstOf(
    options.service,
    env.SERVICE_NAME,
    pkg?.name,
    "unknown",
  );

  const version = firstOf(
    options.version,
    env.SERVICE_VERSION,
    pkg?.version,
    "unknown",
  );

  const instanceId = firstOf(
    options.instanceId,
    env.HOSTNAME,
    host,
    randomUUID(),
  );

  const level = firstOf(
    options.level,
    env.LOG_LEVEL,
    isProduction ? "info" : "debug",
  );

  const pretty = firstOf(
    options.pretty,
    parsePrettyEnv(env.LOG_PRETTY),
    !isProduction,
  );

  const seqLevel = firstOf(options.seqLevel, isProduction ? "warn" : "info");

  const seq = buildSeqConfig(options.seq ?? {}, env);

  const stdoutAsync = firstOf(options.stdoutAsync, true);

  const destination = options.destination ?? null;

  const config = {
    /** Resolved service name (source of the `[APP]` message tag). */
    service,
    /** Minimum pino log level. */
    level,
    /** Deployment environment (`development`, `production`, …). */
    environment,
    /** Deployed version string. */
    version,
    /** Unique instance identifier. */
    instanceId,
    /** Node.js version, included in every event's base fields. */
    nodeVersion: process.version,
    /** Whether to pretty‑print console output with pino‑pretty. */
    pretty,
    /** Seq stream config (only defined when `SEQ_SERVER_URL` is set). */
    seq,
    /** Minimum level routed to the Seq stream. */
    seqLevel,
    /** Per-outcome pino level overrides, merged over the built-in defaults. */
    outcomeLevels: options.outcomeLevels ?? {},
    /** Extra redaction path descriptors to merge with the defaults. */
    redact: options.redact ?? [],
    /** Default redaction paths to deliberately remove. */
    redactRemove: options.redactRemove ?? [],
    /** Replacement value or `(value, path) => string` function. */
    redactCensor: options.redactCensor ?? null,
    /** Extra redaction paths from `LOG_REDACT_PATHS` (comma‑separated). */
    redactEnvPaths: (env.LOG_REDACT_PATHS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** Extra pino `base` fields merged into every event. */
    base: options.base ?? {},
    /** Extra pino serializers merged over the defaults. */
    serializers: options.serializers ?? {},
    /** Custom writable destination for testing. Bypasses all stream assembly. */
    destination,
    /** Use `pino.destination({ sync: false })` for stdout in production. */
    stdoutAsync,
  };

  return Object.freeze(config);
}
