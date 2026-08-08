import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createLogger } from "../src/logger.js";
import { enrichEvent, startEvent, endEvent } from "../src/context.js";
import { expressMiddleware } from "../src/middleware/express.js";

/**
 * Minimal stub `res` for testing Express middleware.
 */
function stubRes() {
  const headers = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => (headers[name.toLowerCase()] = value),
    headersSent: false,
  });
  return res;
}

describe("expressMiddleware", () => {
  /** @type {ReturnType<createLogger>} */
  let h;

  const makeLogger = (extra = {}) => {
    const dest = (() => {
      const lines = [];
      const stream = new Writable({
        write(chunk, _e, cb) {
          lines.push(chunk.toString().trim());
          cb();
        },
      });
      stream.parsed = () => lines.filter(Boolean).map((l) => JSON.parse(l));
      return stream;
    })();

    h = createLogger({
      service: "web",
      destination: dest,
      pretty: false,
      ...extra,
    });
    return dest;
  };

  it("sets x-request-id response header", async () => {
    makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "GET", url: "/test", headers: {} };
    const res = stubRes();

    let called = false;
    mw(req, res, () => {
      called = true;
    });
    assert.ok(called);
    // UUID is 36 chars (with dashes)
    assert.equal(res.getHeader("x-request-id").length, 36);
  });

  it("propagates an inbound x-request-id", async () => {
    makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = {
      method: "POST",
      url: "/checkout",
      headers: { "x-request-id": "inbound-1234" },
    };
    const res = stubRes();

    let called = false;
    mw(req, res, () => {
      called = true;
    });
    assert.ok(called);
    assert.equal(res.getHeader("x-request-id"), "inbound-1234");
  });

  it("emits exactly one event on finish", async () => {
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = {
      method: "POST",
      route: { path: "/checkout" },
      url: "/checkout",
      headers: { "user-agent": "test-agent" },
    };
    const res = stubRes();
    res.statusCode = 201;

    await new Promise((resolve) => {
      mw(req, res, () => {});
      res.on("finish", () => {
        const events = dest.parsed();
        assert.equal(events.length, 1);
        const e = events[0];
        assert.equal(e["@request_id"].length, 36);
        assert.equal(e["@method"], "POST");
        assert.equal(e["@route"], "/checkout");
        assert.equal(e["@user_agent"], "test-agent");
        assert.equal(e["@status_code"], 201);
        assert.equal(e["@outcome"], "success");
        assert.equal(e.level, "info");
        assert.ok(e["@duration_ms"] >= 0);
        resolve();
      });
      res.emit("finish");
    });
  });

  it("reports error outcome for 500 status codes", async () => {
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "GET", url: "/fail", headers: {} };
    const res = stubRes();
    res.statusCode = 500;

    await new Promise((resolve) => {
      mw(req, res, () => {});
      res.on("finish", () => {
        const e = dest.parsed()[0];
        assert.equal(e["@outcome"], "error");
        assert.equal(e["@status_code"], 500);
        assert.equal(e.level, "error");
        resolve();
      });
      res.emit("finish");
    });
  });

  it("reports client_error outcome for 4xx status codes", async () => {
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "GET", url: "/not-found", headers: {} };
    const res = stubRes();
    res.statusCode = 404;

    await new Promise((resolve) => {
      mw(req, res, () => {});
      res.on("finish", () => {
        const e = dest.parsed()[0];
        assert.equal(e["@outcome"], "client_error");
        assert.equal(e.level, "info");
        resolve();
      });
      res.emit("finish");
    });
  });

  it("does not emit before finish", async () => {
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "GET", url: "/", headers: {} };
    const res = stubRes();

    let ended = false;
    mw(req, res, () => {
      ended = true;
    });

    assert.ok(ended);
    assert.equal(dest.parsed().length, 0, "no event before finish");
  });

  it("includes handler enrichment from enrichEvent in the emitted event", async () => {
    // Regression: the middleware and enrichEvent must share the same
    // AsyncLocalStorage store, otherwise handler context is silently dropped.
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "POST", url: "/checkout", headers: {} };
    const res = stubRes();
    res.statusCode = 201;

    await new Promise((resolve) => {
      mw(req, res, () => {
        // Simulate a handler enriching the wide event after the middleware ran.
        enrichEvent({
          user: { id: "u_1", subscription: "enterprise" },
          total_cents: 249900,
        });
        resolve();
      });

      res.on("finish", () => {
        const e = dest.parsed()[0];
        assert.deepEqual(e.user, { id: "u_1", subscription: "enterprise" });
        assert.equal(e.total_cents, 249900);
      });

      res.emit("finish");
    });
  });

  it("includes startEvent-based fields in the emitted event", async () => {
    // Regression: a handler that calls startEvent() replaces the withContext
    // store — the middleware must emit from the live ALS store, not a stale one.
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "POST", url: "/checkout", headers: {} };
    const res = stubRes();
    res.statusCode = 201;

    await new Promise((resolve) => {
      mw(req, res, () => {
        startEvent({ "@job": "handler-started" });
        enrichEvent({ order_id: "ord_1" });
        resolve();
      });

      res.on("finish", () => {
        const e = dest.parsed()[0];
        assert.equal(e["@job"], "handler-started");
        assert.equal(e.order_id, "ord_1");
        assert.equal(e["@status_code"], 201);
      });

      res.emit("finish");
    });
  });

  it("emits exactly one event when the handler calls endEvent", async () => {
    // A handler that completes the wide event itself must not produce a second
    // line from the middleware's finish handler.
    const dest = makeLogger();
    const mw = expressMiddleware(h.logger);
    const req = { method: "POST", url: "/checkout", headers: {} };
    const res = stubRes();
    res.statusCode = 201;

    await new Promise((resolve) => {
      mw(req, res, () => {
        startEvent({});
        endEvent("success", { order_id: "ord_1" });
        resolve();
      });

      res.on("finish", () => {
        const events = dest.parsed();
        assert.equal(events.length, 1);
        assert.equal(events[0].order_id, "ord_1");
      });

      res.emit("finish");
    });
  });
});
