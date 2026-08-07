/* eslint-disable no-console */
/**
 * Minimal example — the "hello world" of @alexdevuwu/logging.
 *
 *   npm run example:basic
 */

import { createLogger } from "@alexdevuwu/logging";

const { logger, close } = createLogger({ service: "basic-example" });

logger.info({ startup: true }, "logger initialised");
logger.debug({ detail: "verbose" }, "debug is on in development");

const stripeLogger = logger.child({ component: "stripe" });
stripeLogger.info(
  { customer_id: "cus_42", amount_cents: 1499 },
  "payment succeeded",
);

stripeLogger.warn({ customer_id: "cus_42", attempt: 3 }, "payment retry");

logger.info({ cleanup: true }, "example complete");

await close();
console.log("Done — all events flushed.");
