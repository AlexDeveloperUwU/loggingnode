/**
 * Secret field names redacted by default, each matched at the top level and at
 * **any** nesting depth. Unlike pino's `*.name` wildcard (which only matches one
 * level), the library's own redactor walks the whole event, so
 * `config.database.password` is masked just like `password`.
 */
const SECRET_NAMES = [
  "password",
  "passwd",
  "secret",
  "authorization",
  "x-api-key",
  "cookie",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apiKey",
  "private_key",
  "credit_card",
  "card_number",
  "cvv",
  "ssn",
];

/**
 * Explicit `headers.*` paths covering common HTTP header objects. These are
 * technically redundant with the any-depth name matching above (each name is
 * also a `*.name` path), but kept explicit and cheap to satisfy the documented
 * `headers.*` contract.
 */
const HEADER_PATHS = [
  "headers.authorization",
  "headers.cookie",
  'headers["x-api-key"]',
  'headers["set-cookie"]',
];

/**
 * Default redaction paths applied to every log event.
 *
 * Each secret name appears bare and as a `*.`-wildcard; both are treated as
 * "match this key at any depth" by the redactor.
 */
export const DEFAULT_REDACT_PATHS = [
  ...SECRET_NAMES,
  ...SECRET_NAMES.map((name) => `*.${name}`),
  ...HEADER_PATHS,
];

/**
 * Extract the leaf (last segment) of a redaction path, unquoting bracket
 * segments: `'*.*.token'` → `'token'`, `'headers["x-api-key"]'` → `'x-api-key'`.
 *
 * @param {string} path
 * @returns {string}
 */
function leafName(path) {
  const segments = parsePath(path);
  return segments[segments.length - 1] ?? path;
}

/**
 * Split a redaction path into segments, supporting dot notation, bracket
 * notation with or without quotes, and `*` wildcards:
 * `'headers["x-api-key"]'` → `['headers', 'x-api-key']`, `'a.*.b'` → `['a', '*', 'b']`.
 *
 * @param {string} path
 * @returns {string[]}
 */
function parsePath(path) {
  const segments = [];
  let current = "";
  let inBrackets = false;
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < path.length; i++) {
    const char = path[i];
    if (!inBrackets && char === ".") {
      if (current) {
        segments.push(current);
        current = "";
      }
    } else if (char === "[") {
      if (current) {
        segments.push(current);
        current = "";
      }
      inBrackets = true;
    } else if (char === "]" && inBrackets) {
      if (current) segments.push(current);
      current = "";
      inBrackets = false;
      inQuotes = false;
      quoteChar = "";
    } else if ((char === '"' || char === "'") && inBrackets && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = "";
    } else {
      current += char;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Default proportional-mask censor (the 75/25 rule).
 *
 * Values shorter than 3 characters → `***`.
 * Otherwise 75% of the characters are replaced with `*`; the last 25% remain visible.
 *
 * @param {unknown} value - The matched field value.
 * @returns {string}
 */
export function defaultCensor(value) {
  const str = typeof value === "string" ? value : String(value ?? "");
  if (str.length < 3) return "***";
  const shown = Math.max(1, Math.round(str.length * 0.25));
  return "*".repeat(str.length - shown) + str.slice(-shown);
}

/**
 * True when the redactor should recurse into `value` (plain objects and arrays).
 * Class instances, Dates, Errors, Maps, etc. are treated as opaque values.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isWalkable(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Build the final pino-compatible `redact` path list.
 *
 * @param {object} opts
 * @param {string[]} [opts.paths] - Extra redaction paths to merge with the defaults.
 * @param {string[]} [opts.remove] - Default paths to deliberately remove (opt-out).
 *   Removing a name removes every variant of it (top‑level, all wildcard depths,
 *   and `headers.*` entries with the same leaf name).
 * @param {string|function} [opts.censor] - Replacement value or `(value, path) => string` function.
 *   Defaults to {@link defaultCensor}.
 * @returns {{ paths: string[], censor: string|function }}
 */
export function buildRedact(opts = {}) {
  const remove = new Set(opts.remove ?? []);
  const merged = [...DEFAULT_REDACT_PATHS, ...(opts.paths ?? [])].filter(
    (p) => {
      if (remove.has(p)) return false;
      for (const r of remove) {
        if (leafName(p) === r) return false;
      }
      return true;
    },
  );
  const paths = [...new Set(merged)];
  return { paths, censor: opts.censor ?? defaultCensor };
}

/**
 * Create a deep-redaction function from a list of paths.
 *
 * The compiled matcher walks the event **once**, in a single pass, and only
 * clones the branches that actually contain a match — events with no sensitive
 * keys pass through with zero allocation. Matching semantics:
 *
 * - `name` and `*.name` → key matched at **any** depth
 * - `a.b.c` → exact chain matched from the root (bracket notation supported)
 * - `a.*.b` → `*` matches any single key in the chain
 * - `*` → matches every key at every depth
 *
 * @param {object} opts
 * @param {string[]} opts.paths - Redaction paths (defaults + user paths, post‑removal).
 * @param {string|function} [opts.censor=defaultCensor] - Replacement value or
 *   `(value, path) => string`; `path` is the key chain as an array.
 * @returns {(value: unknown) => unknown}
 */
export function createRedactor({ paths, censor = defaultCensor }) {
  if (!paths || paths.length === 0) return (value) => value;

  const anyDepth = new Set();
  const exact = [];
  let matchAll = false;

  for (const path of paths) {
    const segments = parsePath(path);
    if (segments.length === 0) continue;
    if (segments.length === 1 && segments[0] === "*") {
      matchAll = true;
      continue;
    }
    if (segments.length === 2 && segments[0] === "*") {
      anyDepth.add(segments[1]);
      continue;
    }
    if (segments.length === 1) {
      anyDepth.add(segments[0]);
      continue;
    }
    exact.push(segments);
  }

  const censorValue = typeof censor === "function" ? censor : () => censor;

  /**
   * @param {unknown} value
   * @param {string[]} path - Key chain from the root of the event.
   * @param {string[][]} remaining - Exact-path suffixes still live at this depth.
   * @returns {unknown} The same reference when nothing below changed.
   */
  function redactValue(value, path, remaining) {
    if (Array.isArray(value)) {
      let changed = false;
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (isWalkable(item)) {
          const redacted = redactValue(item, path, remaining);
          if (redacted !== item) changed = true;
          out[i] = redacted;
        } else {
          out[i] = item;
        }
      }
      return changed ? out : value;
    }

    if (!isWalkable(value)) return value;

    let changed = false;
    const out = {};
    for (const key of Object.keys(value)) {
      const val = value[key];
      const keyPath = path.concat(key);

      let hit = matchAll || anyDepth.has(key);
      let nextRemaining = null;
      for (const suffix of remaining) {
        if (suffix[0] === key || suffix[0] === "*") {
          if (suffix.length === 1) {
            hit = true;
          } else {
            if (!nextRemaining) nextRemaining = [];
            nextRemaining.push(suffix.slice(1));
          }
        }
      }

      if (hit) {
        changed = true;
        out[key] = censorValue(val, keyPath);
      } else if (isWalkable(val)) {
        const redacted = redactValue(val, keyPath, nextRemaining ?? []);
        if (redacted !== val) changed = true;
        out[key] = redacted;
      } else {
        out[key] = val;
      }
    }
    return changed ? out : value;
  }

  return (value) => {
    if (!isWalkable(value)) return value;
    return redactValue(value, [], exact);
  };
}
