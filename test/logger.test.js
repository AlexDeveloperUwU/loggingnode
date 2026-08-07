import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStream } from "./_helpers.js";
import {
  createLogger,
  initLogger,
  getLogger,
  resetLogger,
} from "../src/logger.js";
import { resetRequestContext } from "../src/context.js";

describe("createLogger", () => {
  /** @type {ReturnType<createMemoryStream>} */
  let dest;

  beforeEach(() => {
    dest = createMemoryStream();
  });

  afterEach(() => {
    resetLogger();
    resetRequestContext();
  });

  it("emits JSON lines with auto‑detected base fields", () => {
    // Explicit version to avoid picking up the library's own package.json version.
    const { logger, flush } = createLogger({
      service: "test-svc",
      environment: "test",
      version: "1.0.0",
      commitHash: "abc1234",
      region: "eu-west",
      instanceId: "instance-1",
      destination: dest,
      pretty: false,
    });

    logger.info({ key: "val" }, "test message");
    flush();
    const events = dest.parsed();

    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.level, "info");
    assert.equal(e["@service"], "test-svc");
    assert.equal(e["@version"], "1.0.0");
    assert.equal(e["@environment"], "test");
    assert.equal(e["@instance_id"], "instance-1");
    assert.equal(e["@node_version"], process.version);
    assert.equal(e.key, "val");
    assert.ok(e.time.endsWith("Z"));
    assert.ok(!("@commit_hash" in e));
    assert.ok(!("@region" in e));
  });

  it("prepends the [APP] · message tag", () => {
    const { logger, flush } = createLogger({
      service: "billing-api",
      destination: dest,
      pretty: false,
    });

    logger.info({}, "order created");
    flush();
    const events = dest.parsed();

    assert.equal(events[0].msg, "[BIL] · order created");
  });

  it("uses UNK tag when service is unknown", () => {
    const { logger, flush } = createLogger({
      service: "unknown",
      destination: dest,
      pretty: false,
    });

    logger.info("hello");
    flush();
    assert.equal(dest.parsed()[0].msg, "[UNK] · hello");
  });

  it("pads short service names with *", () => {
    const { logger, flush } = createLogger({
      service: "ap",
      destination: dest,
      pretty: false,
    });

    logger.info("short");
    flush();
    assert.equal(dest.parsed()[0].msg, "[AP*] · short");
  });

  it("emits string level labels (not numbers)", () => {
    const { logger, flush } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
    });

    logger.error({}, "fail");
    flush();
    assert.equal(dest.parsed()[0].level, "error");
  });

  it("uses ISO‑8601 timestamps (not epoch numbers)", () => {
    const { logger, flush } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
    });

    logger.info("ts");
    flush();
    const { time } = dest.parsed()[0];
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(time));
  });

  it("child logger inherits base and adds component", () => {
    const { logger, flush } = createLogger({
      service: "parent",
      destination: dest,
      pretty: false,
    });

    const child = logger.child({ component: "stripe" });
    child.info({}, "from child");
    flush();
    const events = dest.parsed();

    assert.equal(events[0]["@service"], "parent");
    assert.equal(events[0].component, "stripe");
  });

  it("respects the minimum log level", () => {
    const { logger, flush } = createLogger({
      service: "svc",
      level: "warn",
      destination: dest,
      pretty: false,
    });

    logger.info("ignored");
    logger.warn("emitted");
    flush();
    const events = dest.parsed();

    assert.equal(events.length, 1);
    assert.equal(events[0].msg, "[SVC] · emitted");
  });

  it("redacts sensitive fields", () => {
    const { logger, flush } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
    });

    logger.info({ password: "hunter2", user: "alice" }, "login");
    flush();
    const e = dest.parsed()[0];

    assert.notEqual(e.password, "hunter2");
    assert.equal(e.user, "alice");
  });

  it("uses the custom censor when provided", () => {
    const { logger, flush } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
      redactCensor: "CENSORED",
    });

    // We need a non‑default path or override a default.
    logger.info({ password: "hunter2" }, "msg");
    flush();
    assert.equal(dest.parsed()[0].password, "CENSORED");
  });

  it("flush resolves without Seq stream", async () => {
    const { logger, flush } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
    });

    logger.info("flush test");
    await flush();
    assert.equal(dest.parsed().length, 1);
  });

  it("close resolves without Seq stream", async () => {
    const { logger, close } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
    });

    logger.info("close test");
    await close();
    assert.equal(dest.parsed().length, 1);
  });

  it("close is idempotent", async () => {
    const { close } = createLogger({
      service: "svc",
      destination: dest,
      pretty: false,
    });

    await close();
    await close(); // should not throw
  });
});

describe("initLogger / getLogger", () => {
  afterEach(() => resetLogger());

  it("getLogger throws before initLogger", () => {
    assert.throws(() => getLogger(), /not initialised/i);
  });

  it("getLogger returns the logger after initLogger", () => {
    const { logger } = initLogger({ service: "svc", pretty: false });
    // Can't inject destination with initLogger, but getLogger works.
    assert.ok(getLogger());
    assert.strictEqual(getLogger(), logger);
  });

  it("initLogger replaces the previous handle", () => {
    const first = initLogger({ service: "first", pretty: false });
    const second = initLogger({ service: "second", pretty: false });
    assert.notStrictEqual(first.logger, second.logger);
    assert.strictEqual(getLogger(), second.logger);
  });
});
