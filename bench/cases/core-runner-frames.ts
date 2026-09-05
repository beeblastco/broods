/**
 * The NDJSON frame protocol shared by the isolate pool, the hook loader and the
 * hosted-MCP Lambda. Every line of output from every run of uploaded account
 * code is parsed here, so this scales with streamed tokens, not with requests.
 */

import {
  FrameQueue,
  parseRunnerFrame,
} from "../../apps/core/src/harness/frames.ts";
import type { BenchCase } from "../runner.ts";

// One line of each frame kind the protocol defines, plus the two non-protocol
// shapes a runner emits in practice: a bare stderr line and a blank.
const FRAME_LINES: readonly string[] = [
  JSON.stringify({
    t: "chunk",
    output: "The quick brown fox jumps over the lazy dog.",
  }),
  JSON.stringify({
    t: "chunk",
    output: { delta: "partial tool output", index: 41 },
  }),
  JSON.stringify({
    t: "final",
    id: "req_7f3c9d21",
    result: {
      ok: true,
      rows: [1, 2, 3],
      summary: "wrote 3 rows to the workspace",
    },
    cpuUsec: 18_402,
  }),
  JSON.stringify({
    t: "log",
    level: "info",
    message: "connecting to upstream",
  }),
  JSON.stringify({
    t: "error",
    id: "req_7f3c9d21",
    error: "fetch failed: ECONNREFUSED",
  }),
  JSON.stringify({ t: "end", cpuUsec: 21_119 }),
  "npm warn deprecated punycode@2.3.1: use a userland alternative",
  "",
];

// A stdout chunk as it actually arrives: several whole frames plus a partial
// tail the queue must hold until the next chunk completes it.
const STDOUT_CHUNK = `${FRAME_LINES.join("\n")}\n${JSON.stringify({ t: "chunk", output: "trail" }).slice(0, 20)}`;

export const coreRunnerFrameCases: readonly BenchCase[] = [
  {
    name: "core/runner-frame-parse",
    iterations: 20_000,
    run: (): unknown => {
      return parseRunnerFrame(FRAME_LINES[lineCursor++ % FRAME_LINES.length]!);
    },
  },
  {
    name: "core/runner-frame-chunk-ingest",
    iterations: 5_000,
    // One queue per iteration is the real unit: a queue lives for one run, and
    // reusing one here would let parsed frames pile up unboundedly and turn the
    // measurement into a study of array growth.
    run: (): unknown => {
      const queue = new FrameQueue();
      queue.push(STDOUT_CHUNK);
      queue.close();

      return queue;
    },
  },
];

let lineCursor = 0;
