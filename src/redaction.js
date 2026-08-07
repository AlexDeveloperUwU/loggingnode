/**
 * Default redaction paths applied to every log event.
 * Each path is matched at the top level and as a `*.` wildcard at any depth.
 * `headers.*` variants cover common HTTP header objects.
 */
export const DEFAULT_REDACT_PATHS = [
  "password",
  "*.password",
  "passwd",
  "*.passwd",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "x-api-key",
  "*.x-api-key",
  'headers["x-api-key"]',
  "cookie",
  "*.cookie",
  "headers.cookie",
  'headers["set-cookie"]',
  "token",
  "*.token",
  "access_token",
  "*.access_token",
  "refresh_token",
  "*.refresh_token",
  "id_token",
  "*.id_token",
  "api_key",
  "*.api_key",
  "apiKey",
  "*.apiKey",
  "private_key",
  "*.private_key",
  "credit_card",
  "*.credit_card",
  "card_number",
  "*.card_number",
  "cvv",
  "*.cvv",
  "ssn",
  "*.ssn",
];

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
 * Build the final pino `redact` configuration.
 *
 * @param {object} opts
 * @param {string[]} [opts.paths] - Extra redaction paths to merge with the defaults.
 * @param {string[]} [opts.remove] - Default paths to deliberately remove (opt-out).
 * @param {string|function} [opts.censor] - Replacement value or `(value, path) => string` function.
 *   Defaults to {@link defaultCensor}.
 * @returns {{ paths: string[], censor: string|function }}
 */
export function buildRedact(opts = {}) {
  const remove = new Set(opts.remove ?? []);
  const merged = [...DEFAULT_REDACT_PATHS, ...(opts.paths ?? [])].filter(
    (p) => !remove.has(p),
  );
  const paths = [...new Set(merged)];
  return { paths, censor: opts.censor ?? defaultCensor };
}
