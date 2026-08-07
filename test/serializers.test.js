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
});
