/**
 * Folds bench rows (JSON lines from bench.ts) into one row per arm and level:
 * medians across rounds for times, per-task means for CPU, the worst case for
 * memory and failures. Prints a markdown table and writes the JSON next to it.
 *
 * bun summarize.ts <rows.jsonl>... [--json out.json]
 */

import { readFileSync, writeFileSync } from "node:fs";

interface Row {
  label: string;
  kind: string;
  level: number;
  batchMs: number;
  p50: number;
  p95: number;
  exMcpP50: number;
  mcpP50: number;
  ok: number;
  failed: number;
  problems: string[];
  runtimeCpuMs: number;
  runtimeRssStartMb: number;
  runtimeRssPeakMb: number;
  sandboxCpuMs: number;
  sandboxRssPeakMb: number;
  convexCallsPerTask: number;
  modelCallsPerTask: number;
  otherRuntimeModelCalls: number;
}

const files = process.argv
  .slice(2)
  .filter((arg, i, all) => arg !== "--json" && all[i - 1] !== "--json");
const jsonOut = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : undefined;
const rows = files
  .flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Row),
  )
  .filter((row) => row.kind === "batch");

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.label}|${row.level}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
const summary = [...groups.values()]
  .map((group) => {
    const tasks = sum(group.map((r) => r.level));
    return {
      label: group[0]!.label,
      level: group[0]!.level,
      rounds: group.length,
      tasks: tasks,
      ok: sum(group.map((r) => r.ok)),
      failed: sum(group.map((r) => r.failed)),
      p50Ms: median(group.map((r) => r.p50)),
      p95Ms: median(group.map((r) => r.p95)),
      exMcpP50Ms: median(group.map((r) => r.exMcpP50)),
      mcpP50Ms: median(group.map((r) => r.mcpP50)),
      batchMs: median(group.map((r) => r.batchMs)),
      tasksPerMin: (60_000 * tasks) / sum(group.map((r) => r.batchMs)),
      coreCpuMsPerTask: sum(group.map((r) => r.runtimeCpuMs)) / tasks,
      // A batch whose sandbox process died mid-way has no CPU reading (null).
      sandboxCpuMsPerTask:
        sum(
          group
            .filter((r) => Number.isFinite(r.sandboxCpuMs))
            .map((r) => r.sandboxCpuMs),
        ) /
        sum(
          group
            .filter((r) => Number.isFinite(r.sandboxCpuMs))
            .map((r) => r.level),
        ),
      coreRssPeakMb: Math.max(...group.map((r) => r.runtimeRssPeakMb)),
      coreRssStartMb: Math.min(...group.map((r) => r.runtimeRssStartMb)),
      sandboxRssPeakMb: Math.max(...group.map((r) => r.sandboxRssPeakMb)),
      convexCallsPerTask:
        sum(group.map((r) => r.convexCallsPerTask * r.level)) / tasks,
      modelCallsPerTask:
        sum(group.map((r) => r.modelCallsPerTask * r.level)) / tasks,
      otherRuntimeModelCalls: sum(group.map((r) => r.otherRuntimeModelCalls)),
      problems: [...new Set(group.flatMap((r) => r.problems))],
    };
  })
  .sort((a, b) => a.label.localeCompare(b.label) || a.level - b.level);

const f = (n: number): string => (Number.isFinite(n) ? n.toFixed(0) : "-");
console.log(
  "| arm | tasks at once | rounds | ok | p50 ms | p95 ms | p50 ex-MCP ms | tasks/min | core CPU ms/task | sandbox CPU ms/task | core RSS peak MB | sandbox RSS peak MB | Convex calls/task | model calls/task | other runtime model calls |",
);
console.log(
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
);
for (const s of summary) {
  console.log(
    `| ${s.label} | ${s.level} | ${s.rounds} | ${s.ok}/${s.tasks} | ${f(s.p50Ms)} | ${f(s.p95Ms)} | ${f(s.exMcpP50Ms)} | ${s.tasksPerMin.toFixed(1)} | ${f(s.coreCpuMsPerTask)} | ${f(s.sandboxCpuMsPerTask)} | ${f(s.coreRssPeakMb)} | ${f(s.sandboxRssPeakMb)} | ${s.convexCallsPerTask.toFixed(1)} | ${s.modelCallsPerTask.toFixed(1)} | ${s.otherRuntimeModelCalls} |`,
  );
}
for (const s of summary.filter((x) => x.problems.length))
  console.log(`- ${s.label} @${s.level}: ${s.problems.join(" | ")}`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
