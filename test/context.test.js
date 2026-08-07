import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStream } from "./_helpers.js";
import { createLogger, resetLogger } from "../src/logger.js";
import {
  withContext,
  startEvent,
  enrichEvent,
  endEvent,
  getContext,
  resetRequestContext,
} from "../src/context.js";

describe("wide‑event context", () => {
  /** @type {ReturnType<createMemoryStream>} */
  let dest;
  let flush;

  beforeEach(() => {
    dest = createMemoryStream();
    const h = createLogger({
      service: "context-test",
      destination: dest,
      pretty: false,
    });
    flush = h.flush;
  });

  afterEach(() => {
    resetLogger();
    resetRequestContext();
  });

  it("startEvent generates a request_id (UUID format)", async () => {
    await withContext({}, async () => {
      const store = startEvent();
      assert.ok(store);
      assert.ok(/^[\da-f-]{36}$/.test(store["@request_id"]));
    });
  });

  it("startEvent honours a provided @request_id", async () => {
    await withContext({}, async () => {
      const store = startEvent({ "@request_id": "req-custom" });
      assert.equal(store["@request_id"], "req-custom");
    });
  });

  it("startEvent also accepts bare request_id for convenience", async () => {
    await withContext({}, async () => {
      const store = startEvent({ request_id: "bare-req" });
      assert.equal(store["@request_id"], "bare-req");
    });
  });

  it("startEvent returns undefined outside a context", () => {
    assert.equal(startEvent(), undefined);
  });

  it("enrichEvent deep‑merges fields", async () => {
    await withContext({}, async () => {
      startEvent({ "@method": "POST" });
      enrichEvent({ user: { id: "u_1" }, total_cents: 249900 });
      const store = getContext();
      assert.equal(store["@method"], "POST");
      assert.deepEqual(store.user, { id: "u_1" });
      assert.equal(store.total_cents, 249900);
    });
  });

  it("enrichEvent is a no‑op outside a context", () => {
    assert.doesNotThrow(() => enrichEvent({ key: "val" }));
  });

  it("endEvent emits exactly one info line on success", async () => {
    await withContext({}, async () => {
      startEvent({ "@method": "GET" });
      endEvent("success", { "@endpoint": "/health" });
      await flush();
    });
    const events = dest.parsed();
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.level, "info");
    assert.equal(e["@outcome"], "success");
    assert.equal(e["@endpoint"], "/health");
    assert.equal(e["@method"], "GET");
    assert.ok(typeof e["@duration_ms"] === "number");
    assert.ok(e["@duration_ms"] >= 0);
  });

  it("endEvent emits exactly one error line on failure", async () => {
    await withContext({}, async () => {
      startEvent();
      const err = new TypeError("bad type");
      endEvent("error", { err });
      await flush();
    });
    const events = dest.parsed();
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.level, "error");
    assert.equal(e["@outcome"], "error");
    assert.equal(e.msg, "[CON] · request failed");
    assert.deepEqual(e["@error"], {
      type: "TypeError",
      message: "bad type",
      stack: e["@error"].stack, // opaque stack — just verify it's there
    });
    assert.ok(typeof e["@error"].stack === "string");
  });

  it("endEvent serialises non‑Error throws as NonErrorThrow", async () => {
    await withContext({}, async () => {
      startEvent();
      endEvent("error", { err: "just a string" });
      await flush();
    });
    const e = dest.parsed()[0];
    assert.deepEqual(e["@error"], {
      type: "NonErrorThrow",
      message: "just a string",
    });
  });

  it("endEvent is a no‑op when startEvent was never called", async () => {
    await withContext({}, async () => {
      endEvent("success");
      await flush();
    });
    assert.equal(dest.parsed().length, 0);
  });

  it("endEvent is a no‑op outside a context", async () => {
    endEvent("success");
    await flush();
    assert.equal(dest.parsed().length, 0);
  });

  it("strips internal _startHr from the emitted event", async () => {
    await withContext({}, async () => {
      startEvent();
      endEvent("success");
      await flush();
    });
    const e = dest.parsed()[0];
    assert.ok(!("_startHr" in e));
  });

  // --- THE CRITICAL TEST: ALS isolation across interleaved async tasks -----
  it("never cross‑contaminates events across interleaved async tasks", async () => {
    const results = [];

    const taskA = withContext({ task: "A" }, async () => {
      startEvent({ "@request_id": "aaa" });
      await new Promise((r) => setImmediate(r));
      enrichEvent({ a_only: true });
      results.push(getContext());
    });

    const taskB = withContext({ task: "B" }, async () => {
      startEvent({ "@request_id": "bbb" });
      await new Promise((r) => setImmediate(r));
      enrichEvent({ b_only: true });
      results.push(getContext());
    });

    await Promise.all([taskA, taskB]);

    const storeA = results.find((s) => s && s.task === "A");
    const storeB = results.find((s) => s && s.task === "B");

    assert.equal(storeA["@request_id"], "aaa");
    assert.equal(storeB["@request_id"], "bbb");
    assert.ok(storeA.a_only, "task A should have a_only");
    assert.ok(!storeA.b_only, "task A must NOT have b_only");
    assert.ok(storeB.b_only, "task B should have b_only");
    assert.ok(!storeB.a_only, "task B must NOT have a_only");
  });
});
