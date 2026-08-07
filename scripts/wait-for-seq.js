/**
 * Wait for Seq to become reachable before running examples.
 *
 * Polls the Seq ingestion endpoint (http://localhost:5341) up to 10 times
 * with a 1-second delay between attempts. Exits with code 0 when Seq
 * responds, or code 1 after 10 failed attempts.
 *
 *   node scripts/wait-for-seq.js
 */

import { setTimeout } from "node:timers/promises";

const SEQ_INGEST = "http://localhost:5341";
const MAX_ATTEMPTS = 10;

for (let i = 0; i < MAX_ATTEMPTS; i++) {
  try {
    const res = await fetch(SEQ_INGEST, { method: "POST", body: "{}" });
    console.log(`\nSeq ingestion endpoint is ready at ${SEQ_INGEST}`);
    process.exit(0);
  } catch {
    process.stderr.write(".");
  }
  await setTimeout(1000);
}

process.stderr.write(
  `\nSeq not reachable at ${SEQ_INGEST} after ${MAX_ATTEMPTS}s\n`,
);
process.exit(1);
