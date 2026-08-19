/* eslint-disable no-console */
/**
 * Wide‑event example — one canonical log line per logical operation.
 *
 *   npm run example:wide-event
 *
 * Requires no Express — works for any code (workers, cron, CLI, etc.).
 */

import {
  createLogger,
  withContext,
  startEvent,
  enrichEvent,
  endEvent,
} from "@alexdevuwu/logging";

const { logger, close } = createLogger({ service: "event-demo" });

// ── Simulated checkout handler ────────────────────────────────────────────
async function handleCheckout(request) {
  await withContext({}, async () => {
    startEvent({
      "@request_id": request.id,
      "@method": "POST",
      "@route": "/checkout",
      "@user_agent": "demo/1.0",
    });

    let outcome = "success";
    try {
      // Simulate business logic — handlers only enrich, never log.
      const user = await lookupUser(request.userId);
      enrichEvent({
        user: {
          id: user.id,
          subscription: user.tier,
          account_age_days: user.accountAgeDays,
        },
      });

      const order = await createOrder(user, request.cart);
      enrichEvent({
        order_id: order.id,
        total_cents: order.totalCents,
        item_count: order.items.length,
      });
    } catch (err) {
      outcome = "error";
      endEvent(outcome, { err });
      throw err;
    } finally {
      if (outcome === "success") endEvent(outcome);
    }
  });
}

// ── Simulated services ────────────────────────────────────────────────────
async function lookupUser(id) {
  return { id, tier: "enterprise", accountAgeDays: 640 };
}

async function createOrder(_user, cart) {
  return {
    id: "ord_FX29",
    totalCents: cart.reduce((s, i) => s + i.priceCents, 0),
    items: cart,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────
try {
  await handleCheckout({
    id: "req-42",
    userId: "u_1",
    cart: [
      { sku: "WIDGET", priceCents: 99900 },
      { sku: "GADGET", priceCents: 150000 },
    ],
  });
  logger.info({ all_good: true }, "Checkout succeeded");
} catch (err) {
  logger.error({ err }, "Checkout failed");
}

await close();
console.log("Done — wide event emitted as one JSON line to stdout.");
