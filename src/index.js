/**
 * @alexdevuwu/logging — opinionated structured logging for Node.js.
 *
 * Built on pino + pino‑pretty + pino‑seq. One wide event per request, Seq aggregation
 * out of the box, proportional redaction, and zero build step.
 *
 * @module @alexdevuwu/logging
 */

export { createLogger, initLogger, getLogger, resetLogger } from "./logger.js";

export { resolveConfig } from "./config.js";

export {
  startEvent,
  enrichEvent,
  endEvent,
  withContext,
  withOperation,
  getContext,
  initRequestContext,
  resetRequestContext,
  DEFAULT_OUTCOME_LEVELS,
  isFaultOutcome,
  resolveOutcomeLevel,
} from "./context.js";

export {
  DEFAULT_REDACT_PATHS,
  defaultCensor,
  buildRedact,
  createRedactor,
} from "./redaction.js";

export { serializeError } from "./serializers.js";
