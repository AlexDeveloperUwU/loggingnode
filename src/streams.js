import pino from "pino";
import { createStream as createSeqStream } from "pino-seq";
import { createRequire } from "node:module";

let _prettyMissingWarned = false;

/**
 * Build the destination array for `pino.multistream` from the resolved config.
 *
 * Returns `{ streams, seqStream }` where `seqStream` is the pino‑seq writable
 * (or `null`) so the caller can `await seqStream.flush()` on shutdown.
 *
 * @param {object} config - Frozen config from {@link resolveConfig}.
 * @returns {{ streams: Array<{stream: NodeJS.WritableStream, level?: string}>, seqStream: object|null }}
 */
export function buildDestinations(config) {
  const dests = [];
  let seqStream = null;

  if (config.pretty) {
    try {
      const require = createRequire(import.meta.url);
      const prettyFactory = require("pino-pretty");
      const stream = prettyFactory({
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      });
      dests.push({ stream });
    } catch {
      if (!_prettyMissingWarned) {
        _prettyMissingWarned = true;
        process.stderr.write(
          "[AlexDevUwU.Logging] WARNING: pino-pretty not installed — falling back to JSON. " +
            "Install with `npm i -D pino-pretty` for pretty output.\n",
        );
      }
      dests.push({ stream: pino.destination({ sync: !config.stdoutAsync }) });
    }
  } else {
    dests.push({ stream: pino.destination({ sync: !config.stdoutAsync }) });
  }

  if (config.seq) {
    seqStream = createSeqStream(config.seq);
    dests.push({
      level: config.seqLevel,
      stream: seqStream,
    });
  }

  return { streams: dests, seqStream };
}
