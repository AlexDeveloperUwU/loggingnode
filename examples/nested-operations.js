/* eslint-disable no-console */
/**
 * Nested-operations example — withOperation() tracks a sub-action (one whose
 * own outcome is independently meaningful) as its own correlated event.
 *
 *   npm run example:nested-operations
 *
 * The two sub-actions below run concurrently via Promise.all — each gets its
 * own AsyncLocalStorage scope via withOperation, so they can't cross-
 * contaminate each other's enrichEvent() calls, and the parent's outcome
 * stays independent of either child's.
 */

import {
  createLogger,
  withContext,
  startEvent,
  enrichEvent,
  endEvent,
  withOperation,
} from "@alexdevuwu/logging";

const { close } = createLogger({ service: "message-demo" });

// ── Simulated message handler ─────────────────────────────────────────────
async function handleMessage(message) {
  return withContext({}, async () => {
    startEvent({ "@channel": message.channel });
    enrichEvent({ user_id: message.userId });

    try {
      // The warning failing to send is NOT fatal to handling the message —
      // it's logged and swallowed. withOperation still gives it its own
      // fully independent, queryable/alertable row.
      await sendWarning(message).catch(() => {});

      const reply = await msgAI(message);
      endEvent("success");
      return reply;
    } catch (err) {
      endEvent("error", { err });
      throw err;
    }
  });
}

async function sendWarning(message) {
  return withOperation(
    "send-warning",
    { user_id: message.userId, reason: message.flagReason },
    async () => {
      await notifyUser(message.userId);
    },
  );
}

async function msgAI(message) {
  return withOperation("msgAI", { model: "gemini" }, async () => {
    const reply = await queryModel(message.text);
    enrichEvent({ reply_length: reply.length });
    return reply;
  });
}

// ── Simulated services ────────────────────────────────────────────────────
async function notifyUser() {
  throw new Error("delivery failed: user unreachable");
}

async function queryModel(text) {
  return `You said: ${text}`;
}

// ── Run ───────────────────────────────────────────────────────────────────
await handleMessage({
  channel: "whatsapp",
  userId: "u_9021",
  flagReason: "flagged-content",
  text: "hello!",
});

await close();
console.log(
  "Done — one request event plus one event per operation, all correlated by @request_id.",
);
