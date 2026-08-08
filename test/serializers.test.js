import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeError } from "../src/serializers.js";

describe("serializeError", () => {
  it("serializes a plain Error", () => {
    const err = new Error("something broke");
    const result = serializeError(err);
    assert.equal(result.type, "Error");
    assert.equal(result.message, "something broke");
    assert.equal(result.code, undefined);
    assert.ok(typeof result.stack === "string");
    assert.ok(result.stack.includes("Error: something broke"));
  });

  it("serializes a typed error with code", () => {
    const err = new TypeError("bad argument");
    err.code = "ERR_INVALID_ARG";
    const result = serializeError(err);
    assert.equal(result.type, "TypeError");
    assert.equal(result.message, "bad argument");
    assert.equal(result.code, "ERR_INVALID_ARG");
  });

  it("omits the code key when none is set", () => {
    const err = new Error("no code");
    const result = serializeError(err);
    assert.ok(!("code" in result));
  });

  it("wraps non‑Error throws as NonErrorThrow", () => {
    assert.deepEqual(serializeError("a string"), {
      type: "NonErrorThrow",
      message: "a string",
    });
    assert.deepEqual(serializeError(42), {
      type: "NonErrorThrow",
      message: "42",
    });
    assert.deepEqual(serializeError(null), {
      type: "NonErrorThrow",
      message: "null",
    });
  });

  it("handles Error subclasses with custom names", () => {
    class PaymentError extends Error {
      constructor(msg) {
        super(msg);
        this.name = "PaymentError";
        this.code = "PAYMENT_FAILED";
      }
    }
    const result = serializeError(new PaymentError("insufficient funds"));
    assert.equal(result.type, "PaymentError");
    assert.equal(result.message, "insufficient funds");
    assert.equal(result.code, "PAYMENT_FAILED");
  });

  it("serialises error cause chains recursively", () => {
    const inner = new Error("db down");
    inner.code = "ECONNREFUSED";
    const outer = new Error("checkout failed", { cause: inner });
    outer.code = "CHECKOUT_FAILED";

    const result = serializeError(outer);
    assert.equal(result.type, "Error");
    assert.equal(result.message, "checkout failed");
    assert.equal(result.code, "CHECKOUT_FAILED");
    assert.deepEqual(result.cause, {
      type: "Error",
      message: "db down",
      code: "ECONNREFUSED",
      stack: result.cause.stack,
    });
    assert.ok(typeof result.cause.stack === "string");
  });

  it("omits the cause key when there is no cause", () => {
    const result = serializeError(new Error("plain"));
    assert.ok(!("cause" in result));
  });

  it("bounded cause serialisation survives cycles", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b; // cycle
    const result = serializeError(a);
    assert.equal(result.type, "Error");
    assert.equal(result.cause.type, "Error");
    // Depth is bounded, so it terminates.
    let depth = 1;
    let cur = result.cause;
    while (cur?.cause) {
      depth += 1;
      cur = cur.cause;
    }
    assert.ok(depth <= 6);
  });
});
