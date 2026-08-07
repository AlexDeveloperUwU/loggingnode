import { Writable } from "node:stream";

/**
 * Create an in‑memory Writable stream that captures written NDJSON lines.
 *
 * Used as the `destination` test seam — every behavioural assertion in this
 * test suite passes through it. Zero stdout / Seq / network.
 *
 * @returns {NodeJS.WritableStream & { lines: string[], parsed: () => object[] }}
 */
export function createMemoryStream() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString().trim());
      callback();
    },
  });
  stream.lines = lines;
  stream.parsed = () => lines.filter(Boolean).map((l) => JSON.parse(l));
  return stream;
}
