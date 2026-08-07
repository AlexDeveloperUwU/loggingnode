import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStream } from "./_helpers.js";
import { createLogger } from "../src/logger.js";
import {
  DEFAULT_REDACT_PATHS,
  defaultCensor,
  buildRedact,
} from "../src/redaction.js";

describe("defaultCensor", () => {
  it("returns *** for values shorter than 3 chars", () => {
    assert.equal(defaultCensor(""), "***");
    assert.equal(defaultCensor("a"), "***");
    assert.equal(defaultCensor("ab"), "***");
  });

  it("masks 75% and shows the last 25%", () => {
    const result = defaultCensor("supersecret");
    // 11 chars → shown = round(11 * 0.25) = round(2.75) = 3 → 8 hidden, 3 shown
    assert.equal(result.length, 11);
    assert.equal(result, "********ret");
  });

  it("always shows at least 1 char for values >= 3", () => {
    const r4 = defaultCensor("test");
    // 4 chars → shown = round(1) = 1 → 3 hidden, 1 shown
    assert.equal(r4.length, 4);
    assert.equal(r4, "***t");
  });

  it("coerces non‑string values", () => {
    const r = defaultCensor(123456);
    assert.equal(r.length, 6);
    assert.ok(r.startsWith("***"));
    assert.equal(r, "****56");
  });

  it("handles null / undefined", () => {
    assert.equal(defaultCensor(null), "***");
    assert.equal(defaultCensor(undefined), "***");
  });
});

describe("buildRedact", () => {
  it("returns defaults when given no options", () => {
    const redact = buildRedact();
    assert.ok(redact.paths.includes("password"));
    assert.ok(redact.paths.includes("*.authorization"));
    assert.equal(redact.censor, defaultCensor);
  });

  it("merges user paths with defaults", () => {
    const redact = buildRedact({ paths: ["session_id", "*.api_key"] });
    assert.ok(redact.paths.includes("session_id"));
    assert.ok(redact.paths.includes("*.api_key"));
    assert.ok(redact.paths.includes("password")); // defaults preserved
  });

  it("dedepulicates paths", () => {
    const redact = buildRedact({ paths: ["password"] });
    const count = redact.paths.filter((p) => p === "password").length;
    assert.equal(count, 1);
  });

  it("removes paths via redactRemove", () => {
    const redact = buildRedact({ remove: ["password", "*.password"] });
    assert.ok(!redact.paths.includes("password"));
    assert.ok(!redact.paths.includes("*.password"));
    assert.ok(redact.paths.includes("*.authorization"));
  });

  it("accepts a custom censor string", () => {
    const redact = buildRedact({ censor: "X" });
    assert.equal(redact.censor, "X");
  });

  it("accepts a custom censor function", () => {
    const fn = () => "custom";
    const redact = buildRedact({ censor: fn });
    assert.strictEqual(redact.censor, fn);
  });
});

describe("redaction (integration via createLogger)", () => {
  it("redacts nested fields via *. wildcards", () => {
    const dest = createMemoryStream();
    const { logger, flush } = createLogger({
      service: "test",
      destination: dest,
      pretty: false,
    });

    logger.info(
      {
        password: "outer",
        user: { password: "inner" },
        headers: { authorization: "Bearer xyz", cookie: "sid=abc" },
      },
      "login",
    );
    flush();

    const e = dest.parsed()[0];
    assert.notEqual(e.password, "outer");
    assert.notEqual(e.user.password, "inner");
    // The nested .password should be redacted
    assert.ok(e.user.password !== "inner");
    // headers.authorization should NOT be 'Bearer xyz'
    assert.notEqual(e.headers.authorization, "Bearer xyz");
    assert.notEqual(e.headers.cookie, "sid=abc");
  });

  it("redactRemove lets a removed default path through unchanged", () => {
    const dest = createMemoryStream();
    const { logger, flush } = createLogger({
      service: "test",
      destination: dest,
      pretty: false,
      redactRemove: ["password"],
    });

    logger.info({ password: "hunter2" }, "msg");
    flush();
    assert.equal(dest.parsed()[0].password, "hunter2");
  });

  it("DEFAULT_REDACT_PATHS covers all expected keys", () => {
    const keys = [
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
    for (const k of keys) {
      assert.ok(
        DEFAULT_REDACT_PATHS.includes(k),
        `missing top-level path: ${k}`,
      );
      assert.ok(
        DEFAULT_REDACT_PATHS.includes(`*.${k}`),
        `missing wildcard path: *.${k}`,
      );
    }
  });
});
