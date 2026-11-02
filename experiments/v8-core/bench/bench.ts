/**
 * Times the complex agent task on one runtime + sandbox. Each batch starts
 * `level` tasks at once; a task is one SSE run that ends after the subagent's
 * result came back and the parent answered again. Every task is checked from
 * what actually ran: a bash result with a sha256 and the child's real prime
 * count in the parent's final text. Rows go to --out as JSON lines.
 *
 * bun bench.ts --runtime bun|workerd --sandbox machine|v8 --mode scripted|real
 *   --levels 1,5,10 --reps 3 --runtime-pid N [--sandbox-pid N,N] --runtime-log F
 *   --other-log F --out F [--agent-per-task]
 * --other-log is the idle runtime's log: a model call there fails the arm.
 * By default every task runs on one agent, so tasks at once share its sandbox
 * files (one busy agent). --agent-per-task gives each task slot its own agent,
 * and so its own sandbox files, the way many users' tasks arrive.
 * --shared-files (V8 sandbox only) pins each agent's V8 sandbox to one
 * reservation key, so a parent and its subagent see the same files, as they
 * do on a machine's disk; otherwise each agent identity gets its own files.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { sample, sampleOrNaN, watchPeak } from "./proc.ts";
import {
  accountClient,
  complexConfig,
  complexTask,
  createOrgAccount,
  edgeUrl,
  runtimeClient,
  stackState,
  type Runtime,
} from "./lib.ts";

const { values: args } = parseArgs({
  options: {
    runtime: { type: "string" },
    sandbox: { type: "string" },
    mode: { type: "string", default: "scripted" },
    levels: { type: "string", default: "1" },
    reps: { type: "string", default: "3" },
    warmup: { type: "string", default: "2" },
    "runtime-pid": { type: "string" },
    "sandbox-pid": { type: "string" },
    "runtime-log": { type: "string" },
    "other-log": { type: "string" },
    out: { type: "string" },
    label: { type: "string" },
    "agent-per-task": { type: "boolean", default: false },
    "shared-files": { type: "boolean", default: false },
    // One warmup task per agent, all at once, so a router that keeps a
    // worker per agent is measured warm.
    "warmup-each": { type: "boolean", default: false },
  },
});
const runtime = args.runtime as Runtime;
const sandboxKind = args.sandbox as "machine" | "v8";
const real = args.mode === "real";
const apiKey = real ? process.env.ANTHROPIC_API_KEY : "scripted-model";
if (!apiKey) throw new Error("set ANTHROPIC_API_KEY for --mode real");
const runtimePid = Number(args["runtime-pid"]);
const TASK_TIMEOUT_MS = 240_000;
const sandboxPids = args["sandbox-pid"]
  ? args["sandbox-pid"].split(",").map(Number)
  : [];
const label = args.label ?? `${runtime}+${sandboxKind}/${args.mode}`;
const state = stackState();
const runId = Date.now().toString(36);
const secret = createOrgAccount(`bench-${runId}`);
const account = accountClient(state, secret);
const deployed = await new BroodsSyncClient({
  baseUrl: edgeUrl(state),
  token: secret,
}).putManifest(
  {
    version: 1,
    project: `bench-${runId}`,
    stage: "development",
    resources: [
      {
        kind: "mcp",
        name: "cfdocs",
        config: {
          transport: "http",
          url: "https://docs.mcp.cloudflare.com/mcp",
        },
      },
    ],
  },
  true,
);

let daemon: ReturnType<typeof Bun.spawn> | undefined;
let sandboxId: string;
if (sandboxKind === "v8") {
  sandboxId = (
    await account.createSandbox({
      name: `v8-${runId}`,
      config: {
        provider: "worker",
        persistent: true,
        permissionMode: "bypass",
        network: { mode: "deny-all" },
      },
    })
  ).sandboxId;
} else {
  const name = `vm-${runId}`;
  sandboxId = (
    await account.createSandbox({
      name: name,
      config: {
        provider: "machine",
        permissionMode: "bypass",
        network: { mode: "allow-all" },
      },
    })
  ).sandboxId;
  const cwd = `/tmp/bench-machine-${runId}`;
  Bun.spawnSync({ cmd: ["mkdir", "-p", cwd] });
  daemon = Bun.spawn({
    cmd: ["bun", "machine-daemon.ts"],
    env: {
      ...process.env,
      BUN_OPTIONS: "",
      BENCH_ACCOUNT_SECRET: secret,
      BENCH_MACHINE_NAME: name,
      BENCH_EDGE_URL: edgeUrl(state),
      BENCH_MACHINE_CWD: cwd,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stdout.getReader();
  let log = "";
  const deadline = Date.now() + 15_000;
  while (!log.includes(`connected as ${name}`) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    log += new TextDecoder().decode(value);
  }
  if (!log.includes("connected"))
    throw new Error(`machine daemon did not connect: ${log}`);
  sandboxPids.push(daemon.pid);
}
// A sandbox's stored files are keyed by agent and sandbox, so one agent per
// task slot means one set of files per task.
const agentCount = args["agent-per-task"]
  ? Math.max(...args.levels!.split(",").map(Number))
  : 1;
const sandboxIds = await Promise.all(
  Array.from({ length: agentCount }, async (_, i): Promise<string> =>
    sandboxKind === "v8" && args["shared-files"]
      ? (
          await account.createSandbox({
            name: `v8-${runId}-${i}`,
            config: {
              provider: "worker",
              persistent: true,
              permissionMode: "bypass",
              network: { mode: "deny-all" },
              options: { reservationKey: `bench-${runId}-${i}` },
            },
          })
        ).sandboxId
      : sandboxId,
  ),
);
const agents = await Promise.all(
  Array.from({ length: agentCount }, (_, i) =>
    account.createAgent({
      name: `bench-${runId}-${i}`,
      config: complexConfig(apiKey, sandboxIds[i]!, deployed.ids.mcp.cfdocs!),
    }),
  ),
);
const client = runtimeClient(runtime, secret);

interface TaskResult {
  ms: number;
  firstPartMs: number;
  ok: boolean;
  problems: string[];
  toolCalls: number;
  // Time spent waiting on the public MCP server, the same remote for every arm.
  mcpMs: number;
}

async function task(key: string, slot = 0): Promise<TaskResult> {
  const agent = agents[slot % agents.length]!;
  const dir = `task-${key}`;
  const started = performance.now();
  let firstPartMs = 0;
  let text = "";
  let toolCalls = 0;
  let sawSha = false;
  let mcpMs = 0;
  const mcpStarted = new Map<string, number>();
  const problems: string[] = [];
  // A run that never finishes is a failure, not a hang of the whole batch.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const consume = (async (): Promise<void> => {
    for await (const part of client.agent("bench", agent.agentId).stream({
      conversationKey: key,
      input: complexTask(dir),
    })) {
      firstPartMs ||= performance.now() - started;
      if (part.type === "tool-call") {
        toolCalls += 1;
        if (part.toolName.startsWith("cfdocs__"))
          mcpStarted.set(part.toolCallId, performance.now());
      }
      if (
        (part.type === "tool-result" || part.type === "tool-error") &&
        mcpStarted.has(part.toolCallId)
      ) {
        mcpMs += performance.now() - mcpStarted.get(part.toolCallId)!;
      }
      if (
        part.type === "tool-result" &&
        /[0-9a-f]{64}/.test(JSON.stringify(part.output))
      )
        sawSha = true;
      if (part.type === "tool-error")
        problems.push(
          `tool-error ${part.toolName}: ${JSON.stringify(part.error).slice(0, 160)}`,
        );
      if (part.type === "error")
        problems.push(`error: ${JSON.stringify(part).slice(0, 200)}`);
      if (part.type === "text-delta") text += part.text;
    }
  })().catch((error: unknown) => {
    problems.push(`stream threw: ${String(error).slice(0, 200)}`);
  });
  const timedOut = await Promise.race([
    consume.then(() => false),
    new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(true), TASK_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(deadline);
  if (timedOut) problems.push(`timed out after ${TASK_TIMEOUT_MS} ms`);
  if (!sawSha) problems.push("no sha256 in any tool result");
  // A sha256 could hold the digits by chance, so hashes are dropped first.
  const answer = text.replace(/[0-9a-f]{64}/g, "");
  if (!/\b3,?245\b/.test(answer) || !/\b29,?989\b/.test(answer)) {
    problems.push(
      `final text lacks the child's real result: ${text.slice(-200)}`,
    );
  }

  return {
    ms: performance.now() - started,
    firstPartMs: firstPartMs,
    ok: problems.length === 0,
    problems: problems,
    toolCalls: toolCalls,
    mcpMs: mcpMs,
  };
}

// Core on Bun polls Convex in the background (crash recovery, owed async
// results, sandbox cleanup); these never belong to a task, so they are
// counted apart. Core on workerd has no background loop at all.
const BACKGROUND = new Set([
  "runtime:listOwedAsyncAgentResults",
  "runtime:listOwedAsyncToolResults",
  "runtimeIngress:recoverQueued",
  "runtime:listOrphanedSandboxInstances",
  "runtime:listExpiredSandboxReservations",
]);

interface LogCounts {
  convex: number;
  background: number;
  model: number;
}

function logCounts(path: string | undefined): LogCounts {
  if (!path)
    return { convex: Number.NaN, background: Number.NaN, model: Number.NaN };
  const text = readFileSync(path, "utf8");
  let convex = 0;
  let background = 0;
  for (const match of text.matchAll(/BENCH_CONVEX (\S+)/g)) {
    if (BACKGROUND.has(match[1]!)) background += 1;
    else convex += 1;
  }

  return {
    convex: convex,
    background: background,
    model: (text.match(/BENCH_MODEL /g) ?? []).length,
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}

const write = (row: Record<string, unknown>): void => {
  if (args.out)
    appendFileSync(
      args.out,
      `${JSON.stringify({ label: label, at: new Date().toISOString(), ...row })}\n`,
    );
};

for (let i = 0; i < Number(args.warmup); i++) {
  const warm = await task(`warm-${runId}-${i}`);
  console.log(
    `warmup ${i}: ${warm.ms.toFixed(0)} ms ok=${warm.ok} ${warm.problems.join("; ")}`,
  );
}
if (args["warmup-each"]) {
  const warm = await Promise.all(
    agents.map((_, slot) => task(`warm-${runId}-each-${slot}`, slot)),
  );
  console.log(
    `warmup each: ${warm.filter((w) => w.ok).length}/${warm.length} ok, slowest ${Math.max(...warm.map((w) => w.ms)).toFixed(0)} ms`,
  );
}
// Let the warmup's tail writes settle before counting Convex calls.
await Bun.sleep(1000);

for (const level of args.levels!.split(",").map(Number)) {
  for (let rep = 0; rep < Number(args.reps); rep++) {
    const before = {
      runtime: sample(runtimePid),
      sandbox: sandboxPids.map(sampleOrNaN),
      log: logCounts(args["runtime-log"]),
      other: logCounts(args["other-log"]),
    };
    const stopPeak = watchPeak([runtimePid]);
    const stopSandboxPeak = watchPeak(sandboxPids);
    const batchStart = performance.now();
    const results = await Promise.all(
      Array.from({ length: level }, (_, i) =>
        task(`b-${runId}-${level}-${rep}-${i}`, i),
      ),
    );
    const batchMs = performance.now() - batchStart;
    await Bun.sleep(500);
    const after = {
      runtime: sample(runtimePid),
      sandbox: sandboxPids.map(sampleOrNaN),
      log: logCounts(args["runtime-log"]),
      other: logCounts(args["other-log"]),
    };
    const row = {
      kind: "batch",
      level: level,
      rep: rep,
      batchMs: batchMs,
      p50: percentile(
        results.map((r) => r.ms),
        0.5,
      ),
      p95: percentile(
        results.map((r) => r.ms),
        0.95,
      ),
      max: Math.max(...results.map((r) => r.ms)),
      firstPartP50: percentile(
        results.map((r) => r.firstPartMs),
        0.5,
      ),
      mcpP50: percentile(
        results.map((r) => r.mcpMs),
        0.5,
      ),
      exMcpP50: percentile(
        results.map((r) => r.ms - r.mcpMs),
        0.5,
      ),
      exMcpP95: percentile(
        results.map((r) => r.ms - r.mcpMs),
        0.95,
      ),
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      problems: [...new Set(results.flatMap((r) => r.problems))].slice(0, 5),
      toolCallsP50: percentile(
        results.map((r) => r.toolCalls),
        0.5,
      ),
      runtimeCpuMs: after.runtime.cpuMs - before.runtime.cpuMs,
      runtimeRssStartMb: before.runtime.rssMb,
      runtimeRssPeakMb: stopPeak(),
      sandboxCpuMs:
        after.sandbox.reduce((s, x) => s + x.cpuMs, 0) -
        before.sandbox.reduce((s, x) => s + x.cpuMs, 0),
      sandboxRssStartMb: before.sandbox.reduce((s, x) => s + x.rssMb, 0),
      sandboxRssPeakMb: stopSandboxPeak(),
      convexCallsPerTask: (after.log.convex - before.log.convex) / level,
      backgroundConvexCalls: after.log.background - before.log.background,
      modelCallsPerTask: (after.log.model - before.log.model) / level,
      // Must be 0: a model call in the other runtime means it ran part of this arm's work.
      otherRuntimeModelCalls: after.other.model - before.other.model,
      otherRuntimeTaskConvexCalls: after.other.convex - before.other.convex,
      taskMs: results.map((r) => Math.round(r.ms)),
      mcpMs: results.map((r) => Math.round(r.mcpMs)),
    };
    write(row);
    console.log(
      `${label} level ${level} rep ${rep}: batch ${batchMs.toFixed(0)} ms, p50 ${row.p50.toFixed(0)}, p95 ${row.p95.toFixed(0)}, ex-MCP p50 ${row.exMcpP50.toFixed(0)}, ok ${row.ok}/${level}, core cpu ${row.runtimeCpuMs.toFixed(0)} ms, core rss peak ${row.runtimeRssPeakMb.toFixed(0)} MB, sandbox cpu ${row.sandboxCpuMs.toFixed(0)} ms, convex/task ${row.convexCallsPerTask.toFixed(1)}, model/task ${row.modelCallsPerTask.toFixed(1)}, other runtime model calls ${row.otherRuntimeModelCalls}${row.problems.length ? ` problems: ${row.problems.join(" | ")}` : ""}`,
    );
  }
}
// Every run must also have persisted: run.completed is written in the same
// Convex transaction as the run's usage, so a runtime that dropped its tail
// work (say, an isolate torn down before its waitUntil finished) shows here.
const tasksStarted =
  Number(args.warmup) +
  (args["warmup-each"] ? agents.length : 0) +
  args
    .levels!.split(",")
    .map(Number)
    .reduce((s, l) => s + l * Number(args.reps), 0);
let runsCompleted = 0;
for (let i = 0; i < 20; i++) {
  await Bun.sleep(1000);
  const page = await account.audit.list({ limit: 500 });
  const next = page.events.filter(
    (event) => event.action === "run.completed",
  ).length;
  if (next === runsCompleted && i > 2) break;
  runsCompleted = next;
}
write({
  kind: "audit",
  tasksStarted: tasksStarted,
  runsCompleted: runsCompleted,
  runsPerTask: runsCompleted / tasksStarted,
});
console.log(
  `audit: ${runsCompleted} run.completed rows for ${tasksStarted} tasks (${(runsCompleted / tasksStarted).toFixed(2)} per task)`,
);
daemon?.kill();
console.log(JSON.stringify({ runId: runId }));
