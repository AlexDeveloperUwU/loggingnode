import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("falls back to defaults when given no options or env", () => {
    const config = resolveConfig({}, {});
    assert.equal(typeof config.service, "string");
    assert.equal(config.environment, "development");
    assert.equal(config.level, "debug"); // dev default
    assert.equal(config.pretty, true); // dev default
    assert.equal(config.seq, undefined); // no SEQ_SERVER_URL
    assert.equal(config.nodeVersion, process.version);
    assert.equal(config.stdoutAsync, true);
    assert.ok(Object.isFrozen(config));
    assert.ok(!("commitHash" in config));
    assert.ok(!("region" in config));
  });

  it("prefers an explicit option over an env var", () => {
    const config = resolveConfig(
      { service: "my-svc", level: "warn", pretty: false },
      { SERVICE_NAME: "other-svc", LOG_LEVEL: "info", LOG_PRETTY: "1" },
    );
    assert.equal(config.service, "my-svc");
    assert.equal(config.level, "warn");
    assert.equal(config.pretty, false);
  });

  it("falls back to env vars when no explicit option", () => {
    const config = resolveConfig(
      {},
      {
        SERVICE_NAME: "env-svc",
        LOG_LEVEL: "error",
        LOG_PRETTY: "0",
        NODE_ENV: "production",
      },
    );
    assert.equal(config.service, "env-svc");
    assert.equal(config.level, "error");
    assert.equal(config.pretty, false);
    assert.equal(config.environment, "production");
  });

  it("parses LOG_PRETTY variants", () => {
    assert.equal(resolveConfig({}, { LOG_PRETTY: "1" }).pretty, true);
    assert.equal(resolveConfig({}, { LOG_PRETTY: "true" }).pretty, true);
    assert.equal(resolveConfig({}, { LOG_PRETTY: "0" }).pretty, false);
    assert.equal(resolveConfig({}, { LOG_PRETTY: "false" }).pretty, false);
  });

  it("defaults pretty to false in production", () => {
    const config = resolveConfig({ environment: "production" }, {});
    assert.equal(config.pretty, false);
    assert.equal(config.level, "info");
  });

  it("resolves instanceId from HOSTNAME", () => {
    const config = resolveConfig({}, { HOSTNAME: "web-7" });
    assert.equal(config.instanceId, "web-7");
  });

  it("parses LOG_REDACT_PATHS from comma-separated string", () => {
    const config = resolveConfig(
      {},
      { LOG_REDACT_PATHS: "  session_id , *.secret_key  " },
    );
    assert.deepEqual(config.redactEnvPaths, ["session_id", "*.secret_key"]);
  });

  it("builds seq config when SEQ_SERVER_URL is set", () => {
    const config = resolveConfig(
      {
        seq: { apiKey: "opt-key", logOtherAs: "Information" },
      },
      { SEQ_SERVER_URL: "http://localhost:5341", SEQ_API_KEY: "env-key" },
    );
    assert.ok(config.seq);
    assert.equal(config.seq.serverUrl, "http://localhost:5341");
    assert.equal(config.seq.apiKey, "opt-key"); // option > env
    assert.equal(config.seq.logOtherAs, "Information");
  });

  it("returns undefined for seq when no serverUrl is configured", () => {
    assert.equal(resolveConfig({}, {}).seq, undefined);
    assert.equal(
      resolveConfig({ seq: { batchSizeLimit: 1024 } }, {}).seq,
      undefined,
    );
  });

  it("passes through undocumented seq options", () => {
    const config = resolveConfig(
      { seq: { serverUrl: "http://s", customOption: 42 } },
      {},
    );
    assert.equal(config.seq.customOption, 42);
  });

  it("handles numeric seq env vars", () => {
    const config = resolveConfig(
      {},
      {
        SEQ_SERVER_URL: "http://s",
        SEQ_MAX_BATCHING_TIME_MS: "5000",
        SEQ_EVENT_SIZE_LIMIT: "262144",
      },
    );
    assert.equal(config.seq.maxBatchingTime, 5000);
    assert.equal(config.seq.eventSizeLimit, 262144);
  });

  it("sets seqLevel based on environment", () => {
    assert.equal(
      resolveConfig(
        { environment: "production" },
        { SEQ_SERVER_URL: "http://s" },
      ).seqLevel,
      "warn",
    );
    assert.equal(
      resolveConfig({}, { SEQ_SERVER_URL: "http://s" }).seqLevel,
      "info",
    );
  });

  it("preserves user base and serializers", () => {
    const config = resolveConfig({
      base: { datacenter: "eu-west" },
      serializers: { req: () => "serialized" },
    });
    assert.deepEqual(config.base, { datacenter: "eu-west" });
    assert.ok(config.serializers.req);
    assert.equal(config.serializers.req(), "serialized");
  });
});
