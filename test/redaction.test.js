import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStream } from "./_helpers.js";
import { createLogger } from "../src/logger.js";
import {
  DEFAULT_REDACT_PATHS,
  defaultCensor,
  buildRedact,
  createRedactor,
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

  it("redactRemove removes every depth variant of a name", () => {
    const redact = buildRedact({ remove: ["token"] });
    assert.ok(!redact.paths.includes("token"));
    assert.ok(!redact.paths.includes("*.token"));
    assert.ok(!redact.paths.includes("*.*.token"));
    assert.ok(!redact.paths.includes("*.*.*.token"));
    assert.ok(redact.paths.includes("password")); // unrelated names survive
  });

  it("redactRemove on a header name removes its headers.* variant too", () => {
    const redact = buildRedact({ remove: ["x-api-key"] });
    assert.ok(!redact.paths.includes('headers["x-api-key"]'));
    assert.ok(redact.paths.includes('headers["set-cookie"]'));
  });

  it("defaults include every secret name bare and as *.name", () => {
    for (const k of ["password", "token", "api_key"]) {
      assert.ok(DEFAULT_REDACT_PATHS.includes(k), `top-level ${k}`);
      assert.ok(DEFAULT_REDACT_PATHS.includes(`*.${k}`), `*.${k}`);
    }
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

describe("createRedactor", () => {
  it("matches bare names at any depth", () => {
    const redact = createRedactor({ paths: ["password"] });
    const out = redact({
      password: "top",
      user: { password: "one" },
      config: { db: { password: "two" } },
    });
    assert.notEqual(out.password, "top");
    assert.notEqual(out.user.password, "one");
    assert.notEqual(out.config.db.password, "two");
  });

  it("matches *.name wildcards at any depth", () => {
    const redact = createRedactor({ paths: ["*.token"] });
    const out = redact({ a: { b: { token: "x" } } });
    assert.notEqual(out.a.b.token, "x");
  });

  it("matches exact chains from the root", () => {
    const redact = createRedactor({ paths: ["headers.authorization"] });
    const out = redact({
      headers: { authorization: "Bearer x", "x-forwarded-for": "1.2.3.4" },
      nested: { headers: { authorization: "Bearer y" } },
    });
    assert.notEqual(out.headers.authorization, "Bearer x");
    // Exact chains only match at the root, not deeper.
    assert.equal(out.nested.headers.authorization, "Bearer y");
  });

  it("supports bracket notation with quotes", () => {
    const redact = createRedactor({ paths: ['headers["x-api-key"]'] });
    const out = redact({ headers: { "x-api-key": "sk-1" } });
    assert.notEqual(out.headers["x-api-key"], "sk-1");
  });

  it("supports * wildcards mid-chain", () => {
    const redact = createRedactor({ paths: ["req.*.authorization"] });
    const out = redact({ req: { headers: { authorization: "Bearer z" } } });
    assert.notEqual(out.req.headers.authorization, "Bearer z");
  });

  it("a lone * matches every key at every depth", () => {
    const redact = createRedactor({ paths: ["*"] });
    const out = redact({ a: 1, user: { b: 2 } });
    assert.notEqual(out.a, 1);
    assert.notEqual(out.user.b, 2);
  });

  it("returns the same reference when nothing matches (zero copy)", () => {
    const redact = createRedactor({ paths: ["password"] });
    const obj = { user: { id: "u_1" }, total_cents: 100 };
    assert.strictEqual(redact(obj), obj);
  });

  it("returns the identity function for empty paths", () => {
    const redact = createRedactor({ paths: [] });
    const obj = { password: "x" };
    assert.strictEqual(redact(obj), obj);
  });

  it("does not mutate the original object", () => {
    const redact = createRedactor({ paths: ["password"] });
    const obj = { user: { password: "x" } };
    const out = redact(obj);
    assert.notEqual(out.user.password, "x");
    assert.equal(obj.user.password, "x");
  });

  it("redacts inside arrays", () => {
    const redact = createRedactor({ paths: ["password"] });
    const out = redact({ users: [{ password: "a" }, { password: "b" }] });
    assert.notEqual(out.users[0].password, "a");
    assert.notEqual(out.users[1].password, "b");
  });

  it("passes the key chain to a censor function", () => {
    const redact = createRedactor({
      paths: ["password"],
      censor: (value, path) => `${path.join(".")}:${value}`,
    });
    const out = redact({ user: { password: "x" } });
    assert.equal(out.user.password, "user.password:x");
  });

  it("applies a string censor", () => {
    const redact = createRedactor({ paths: ["password"], censor: "REDACTED" });
    assert.equal(redact({ password: "x" }).password, "REDACTED");
  });

  it("treats class instances as opaque values", () => {
    const redact = createRedactor({ paths: ["password"] });
    const date = new Date(0);
    const out = redact({ when: date, password: "x" });
    assert.strictEqual(out.when, date);
    assert.notEqual(out.password, "x");
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

  it("redacts secrets nested two and three levels deep", () => {
    const dest = createMemoryStream();
    const { logger, flush } = createLogger({
      service: "test",
      destination: dest,
      pretty: false,
    });

    logger.info(
      {
        config: { database: { password: "lvl2" } },
        user: { session: { token: "lvl2-tok" } },
        a: { b: { c: { password: "lvl3" } } },
      },
      "msg",
    );
    flush();

    const e = dest.parsed()[0];
    assert.notEqual(e.config.database.password, "lvl2");
    assert.notEqual(e.user.session.token, "lvl2-tok");
    assert.notEqual(e.a.b.c.password, "lvl3");
  });

  it("redacts secrets at any depth, not just one level", () => {
    const dest = createMemoryStream();
    const { logger, flush } = createLogger({
      service: "test",
      destination: dest,
      pretty: false,
    });

    logger.info({ a: { b: { c: { d: { password: "lvl4" } } } } }, "msg");
    flush();
    assert.notEqual(dest.parsed()[0].a.b.c.d.password, "lvl4");
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
