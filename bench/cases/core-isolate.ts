/**
 * The V8 isolate tier that runs account-uploaded hooks: a Node process core
 * spawns because Bun cannot load isolated-vm. Cold is one-shot mode, a fresh
 * runner per call, which is the fallback and the floor of what a first hook
 * costs. Warm is the pooled default, where a tenant's isolate stays resident
 * and each call gets a fresh context.
 *
 * Needs the runner with its native addon built: CI prepares one and points
 * BROODS_TEST_ISOLATE_RUNNER_PATH at it, the same as the isolate tests.
 */

import { createHash } from "node:crypto";
import {
  shutdownIsolatePool,
  streamIsolatePayload,
} from "../../apps/core/src/harness/isolate/executor.ts";
import { muteCoreLogs, unmuteCoreLogs } from "../fixtures/mute-core-logs.ts";
import type { BenchCase } from "../runner.ts";

const RUNNER_PATH_ENV = "BROODS_TEST_ISOLATE_RUNNER_PATH";

// A small but real tool: parses its input, does a little work, returns JSON.
const TOOL_SOURCE = [
  "export default {",
  "  name: 'ledger',",
  "  execute(input) {",
  "    const rows = Array.from({ length: input.n }, (_, i) => ({ id: i, total: i * 3 }));",
  "    return { count: rows.length, sum: rows.reduce((s, r) => s + r.total, 0) };",
  "  },",
  "};",
].join("\n");

const PAYLOAD: Readonly<Record<string, unknown>> = {
  bundleSourceB64: Buffer.from(TOOL_SOURCE).toString("base64"),
  expectedSha256: createHash("sha256").update(TOOL_SOURCE).digest("hex"),
  toolName: "ledger",
  input: { n: 200 },
  config: {},
};

export const coreIsolateCases: readonly BenchCase[] = [
  {
    name: "core/isolate-cold-run",
    iterations: 1,
    samples: 7,
    available: runnerAvailable,
    setup: (): void => installRunner("0"),
    teardown: restoreRunner,
    run: runTool,
  },
  {
    name: "core/isolate-warm-run",
    iterations: 20,
    samples: 11,
    available: runnerAvailable,
    setup: (): void => installRunner(undefined),
    teardown: restoreRunner,
    run: runTool,
  },
];

let savedEnv: Record<string, string | undefined> = {};

function installRunner(pool: string | undefined): void {
  muteCoreLogs();
  savedEnv = {
    ISOLATE_POOL: process.env.ISOLATE_POOL,
    ISOLATE_RUNNER_PATH: process.env.ISOLATE_RUNNER_PATH,
  };
  process.env.ISOLATE_RUNNER_PATH = process.env[RUNNER_PATH_ENV];
  if (pool === undefined) delete process.env.ISOLATE_POOL;
  else process.env.ISOLATE_POOL = pool;
}

function restoreRunner(): void {
  shutdownIsolatePool();
  unmuteCoreLogs();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function runnerAvailable(): boolean {
  return Boolean(process.env[RUNNER_PATH_ENV]);
}

async function runTool(): Promise<unknown> {
  let last: unknown;
  for await (const output of streamIsolatePayload("acct_bench", {
    ...PAYLOAD,
  })) {
    last = output;
  }

  return last;
}
