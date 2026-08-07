import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/config.js";
import { buildDestinations } from "../src/streams.js";

describe("buildDestinations", () => {
  it("produces a single JSON stream in production without Seq", () => {
    const config = resolveConfig(
      { service: "svc", environment: "production" },
      {},
    );
    const { streams, seqStream } = buildDestinations(config);

    assert.equal(streams.length, 1);
    assert.equal(seqStream, null);
    assert.ok(streams[0].stream);
    // No explicit level → inherits the logger level.
    assert.equal(streams[0].level, undefined);
  });

  it("uses the pretty stream in development", () => {
    const config = resolveConfig(
      { service: "svc", environment: "development" },
      {},
    );
    const { streams, seqStream } = buildDestinations(config);

    assert.equal(streams.length, 1);
    assert.equal(seqStream, null);
    // pino-pretty is a dev dependency here, so this is the pretty stream.
    assert.ok(streams[0].stream);
  });

  it("adds a Seq stream with the configured seqLevel when SEQ_SERVER_URL is set", () => {
    const config = resolveConfig(
      { service: "svc", environment: "production" },
      { SEQ_SERVER_URL: "http://localhost:5341" },
    );
    const { streams, seqStream } = buildDestinations(config);

    assert.equal(streams.length, 2);
    assert.ok(seqStream, "seqStream is exposed for flush()");
    assert.equal(typeof seqStream.flush, "function");
    // Production default seqLevel is 'warn'.
    assert.equal(streams[1].level, "warn");
  });

  it("uses info seqLevel in development with Seq", () => {
    const config = resolveConfig(
      { service: "svc", environment: "development" },
      { SEQ_SERVER_URL: "http://localhost:5341" },
    );
    const { streams } = buildDestinations(config);

    assert.equal(streams.length, 2);
    assert.equal(streams[1].level, "info");
  });

  it("honours an explicit seqLevel option", () => {
    const config = resolveConfig(
      { service: "svc", seqLevel: "error" },
      { SEQ_SERVER_URL: "http://localhost:5341" },
    );
    const { streams } = buildDestinations(config);
    assert.equal(streams[1].level, "error");
  });
});
