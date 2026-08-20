import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStream } from "./_helpers.js";
import { createLogger, resetLogger } from "../src/logger.js";
import {
  withContext,
  startEvent,
  enrichEvent,
  endEvent,
  withOperation,
  getContext,
  resetRequestContext,
} from "../src/context.js";

/**
 * Silence + capture `process.stderr.write` for the duration of `fn`, so
 * `warnOnce` calls can be asserted without polluting test output.
 * @param {() => Promise<void>|void} fn
 * @returns {Promise<number>} number of matching writes
 */
async function captureStderr(fn, pattern) {
  const original = process.stderr.write;
  let count = 0;
  process.stderr.write = (msg) => {
    if (pattern.test(String(msg))) count++;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return count;
}

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

  it("enrichEvent deep‑merges nested objects across multiple calls", async () => {
    await withContext({}, async () => {
      startEvent({});
      enrichEvent({ user: { id: "u_1" }, feature_flags: { a: true } });
      enrichEvent({
        user: { subscription: "enterprise" },
        feature_flags: { b: 2 },
      });
      const store = getContext();
      assert.deepEqual(store.user, { id: "u_1", subscription: "enterprise" });
      assert.deepEqual(store.feature_flags, { a: true, b: 2 });
    });
  });

  it("enrichEvent replaces arrays and primitives rather than merging them", async () => {
    await withContext({}, async () => {
      startEvent({});
      enrichEvent({ tags: ["a"], note: "first" });
      enrichEvent({ tags: ["b", "c"], note: "second" });
      const store = getContext();
      assert.deepEqual(store.tags, ["b", "c"]);
      assert.equal(store.note, "second");
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
    assert.equal(e.msg, "[CON] · Request failed");
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

  it("endEvent emits exactly one line when called twice (dedupe)", async () => {
    await withContext({}, async () => {
      startEvent();
      endEvent("success");
      endEvent("success"); // second call is a no‑op
      await flush();
    });
    assert.equal(dest.parsed().length, 1);
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

  it("startEvent mints an @operation_id on a plain top-level event", async () => {
    await withContext({}, async () => {
      const store = startEvent();
      assert.ok(/^[\da-f-]{36}$/.test(store["@operation_id"]));
    });
  });

  it("a bare nested startEvent() merges into the active event instead of resetting it", async () => {
    await withContext({}, async () => {
      const outer = startEvent({ "@request_id": "outer-id" });
      const merged = startEvent({ nested_field: true }); // misuse — should warn + merge
      assert.equal(merged, outer, "same store — not reset via enterWith");
      assert.equal(getContext()["@request_id"], "outer-id");
      assert.equal(getContext().nested_field, true);
      endEvent("success");
      await flush();
    });
    assert.equal(dest.parsed().length, 1); // only one event ever emitted
  });

  describe("withOperation", () => {
    it("emits its own event, correlated to the parent", async () => {
      await withContext({}, async () => {
        startEvent();
        await withOperation("send-warning", { user_id: "u1" }, async () => {
          enrichEvent({ sent: true });
        });
        endEvent("success");
        await flush();
      });
      const events = dest.parsed();
      assert.equal(events.length, 2);
      const parentEvt = events.find((e) => !e["@parent_operation_id"]);
      const child = events.find((e) => e["@parent_operation_id"]);
      assert.ok(parentEvt && child);
      assert.equal(child["@parent_operation_id"], parentEvt["@operation_id"]);
      assert.equal(child["@request_id"], parentEvt["@request_id"]);
      assert.equal(child.user_id, "u1");
      assert.equal(child.sent, true);
      assert.equal(child["@outcome"], "success");
      assert.equal(child.msg, "[CON] · Operation completed");
    });

    it("backfills duration_ms and outcome onto the parent's @child_operations entry", async () => {
      await withContext({}, async () => {
        startEvent();
        await withOperation("check-space", {}, async () => {});
        endEvent("success");
        await flush();
      });
      const parentEvt = dest
        .parsed()
        .find((e) => Array.isArray(e["@child_operations"]));
      assert.equal(parentEvt["@child_operations"].length, 1);
      const entry = parentEvt["@child_operations"][0];
      assert.equal(entry.name, "check-space");
      assert.equal(entry.outcome, "success");
      assert.ok(typeof entry.operation_id === "string");
      assert.ok(typeof entry.duration_ms === "number");
    });

    it("captures a thrown error on the child event and rethrows", async () => {
      await withContext({}, async () => {
        startEvent();
        await assert.rejects(
          () =>
            withOperation("flaky-call", {}, async () => {
              throw new Error("boom");
            }),
          /boom/,
        );
        endEvent("success");
        await flush();
      });
      const events = dest.parsed();
      const child = events.find((e) => e["@parent_operation_id"]);
      const parentEvt = events.find((e) =>
        Array.isArray(e["@child_operations"]),
      );
      assert.equal(child.level, "error");
      assert.equal(child["@outcome"], "error");
      assert.equal(child.msg, "[CON] · Operation failed");
      assert.equal(child["@error"].message, "boom");
      assert.equal(parentEvt["@child_operations"][0].outcome, "error");
    });

    it("endEvent() called inside its callback is a no-op — the real outcome still wins", async () => {
      const warnings = await captureStderr(async () => {
        await withContext({}, async () => {
          startEvent();
          await assert.rejects(
            () =>
              withOperation("stray-end-event", {}, async () => {
                endEvent("success"); // misuse — must not finalize the child early
                throw new Error("actual failure");
              }),
            /actual failure/,
          );
          endEvent("success");
          await flush();
        });
      }, /endEvent\(\) called inside a withOperation/);
      assert.equal(warnings, 1);
      const child = dest.parsed().find((e) => e["@parent_operation_id"]);
      assert.equal(child["@outcome"], "error");
      assert.equal(child["@error"].message, "actual failure");
    });

    it("concurrent siblings don't cross-contaminate enrichEvent", async () => {
      await withContext({}, async () => {
        startEvent();
        const [a, b] = await Promise.all([
          withOperation("op-a", {}, async () => {
            await new Promise((r) => setImmediate(r));
            enrichEvent({ a_only: true });
            return getContext();
          }),
          withOperation("op-b", {}, async () => {
            await new Promise((r) => setImmediate(r));
            enrichEvent({ b_only: true });
            return getContext();
          }),
        ]);
        assert.ok(a.a_only && !a.b_only);
        assert.ok(b.b_only && !b.a_only);
        endEvent("success");
        await flush();
      });
    });

    it("many concurrent siblings all register in @child_operations with no lost pushes", async () => {
      await withContext({}, async () => {
        startEvent();
        await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            withOperation(`op-${i}`, {}, async () => {
              await new Promise((r) => setImmediate(r));
            }),
          ),
        );
        endEvent("success");
        await flush();
      });
      const parentEvt = dest
        .parsed()
        .find((e) => Array.isArray(e["@child_operations"]));
      const names = parentEvt["@child_operations"].map((c) => c.name).sort();
      const expected = Array.from({ length: 20 }, (_, i) => `op-${i}`).sort();
      assert.deepEqual(names, expected);
    });

    it("a grandchild chains @parent_operation_id to its immediate parent, not the root", async () => {
      await withContext({}, async () => {
        startEvent();
        await withOperation("mid", {}, async () => {
          await withOperation("leaf", {}, async () => {});
        });
        endEvent("success");
        await flush();
      });
      const events = dest.parsed();
      const root = events.find((e) => !e["@parent_operation_id"]);
      const mid = events.find(
        (e) =>
          e["@parent_operation_id"] && Array.isArray(e["@child_operations"]),
      );
      const leaf = events.find(
        (e) =>
          e["@parent_operation_id"] && !Array.isArray(e["@child_operations"]),
      );
      assert.ok(root && mid && leaf);
      assert.equal(mid["@parent_operation_id"], root["@operation_id"]);
      assert.equal(leaf["@parent_operation_id"], mid["@operation_id"]);
      assert.equal(root["@child_operations"][0].name, "mid");
      assert.equal(mid["@child_operations"][0].name, "leaf");
    });

    it("caps @child_operations at 50 and counts the rest as truncated", async () => {
      const warnings = await captureStderr(async () => {
        await withContext({}, async () => {
          startEvent();
          for (let i = 0; i < 55; i++) {
            await withOperation(`op-${i}`, {}, async () => {});
          }
          endEvent("success");
          await flush();
        });
      }, /more than 50 child operations/);
      assert.equal(warnings, 1);
      const events = dest.parsed();
      const parentEvt = events.find((e) =>
        Array.isArray(e["@child_operations"]),
      );
      assert.equal(parentEvt["@child_operations"].length, 50);
      assert.equal(parentEvt["@child_operations_truncated"], 5);
      // every child still ran and emitted its own event, listed or not
      assert.equal(events.filter((e) => e["@parent_operation_id"]).length, 55);
    });

    it("respects a configured outcomeLevels override for a child's emission", async () => {
      const dest2 = createMemoryStream();
      const h = createLogger({
        service: "context-test",
        destination: dest2,
        pretty: false,
        outcomeLevels: { error: "warn" },
      });
      await withContext({}, async () => {
        startEvent();
        await assert.rejects(
          () =>
            withOperation("risky", {}, async () => {
              throw new Error("nope");
            }),
          /nope/,
        );
        endEvent("error", { err: new Error("nope") });
        await h.flush();
      });
      const child = dest2.parsed().find((e) => e["@parent_operation_id"]);
      assert.equal(child.level, "warn");
    });

    it("falls back to unknown for an invalid outcome, warning once", async () => {
      const warnings = await captureStderr(async () => {
        await withContext({}, async () => {
          startEvent();
          endEvent("succes"); // typo
          await flush();
        });
        await withContext({}, async () => {
          startEvent();
          endEvent("eror"); // different typo — still only warns once total
          await flush();
        });
      }, /invalid outcome/);
      assert.equal(warnings, 1);
      const events = dest.parsed();
      assert.equal(events[0]["@outcome"], "unknown");
      assert.equal(events[1]["@outcome"], "unknown");
    });
  });
});
