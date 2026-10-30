/**
 * Splits each bench batch's time into model time and tool time from core's own
 * structured log, and adds up the tokens the model used. A batch's events are
 * the runtime's model.step.finished / tool.call.finished lines inside the
 * batch's time window; arms never overlap in time, so nothing is shared.
 * A step's model time is its duration minus its slowest tool (tools in one
 * step run in parallel). Model steps in the other runtimes' logs inside the
 * same window are counted too: any there means a run leaked across arms.
 *
 * bun analyze-log.ts <rows.jsonl> bun=<log> workerd=<log> isolate=<log> [--json out]
 */

import { readFileSync, writeFileSync } from "node:fs";

// claude-haiku-5-5 list prices per million tokens (Anthropic API, prompts up
// to 100K tokens); cache reads at 0.1x input and 5-minute cache writes at 1.25x.
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };

interface Usage {
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}
interface Event {
  eventType: string;
  eventId?: string;
  stepNumber?: number;
  durationMs: number;
  time: string;
  usage?: Usage;
}

const args = process.argv.slice(2);
const rowsPath = args[0]!;
const jsonOut = args.includes("--json")
  ? args[args.indexOf("--json") + 1]
  : undefined;
const logs = Object.fromEntries(
  args
    .filter((a) => a.includes("="))
    .map((a) => {
      const [name, path] = a.split("=") as [string, string];
      const events = readFileSync(path, "utf8")
        .split("\n")
        .filter(
          (line) =>
            line.includes('"model.step.finished"') ||
            line.includes('"tool.call.finished"') ||
            line.includes('"model.invocation.finished"') ||
            line.includes('"model.invocation.failed"'),
        )
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Event);

      return [name, events];
    }),
);

const rows = readFileSync(rowsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const out = rows
  .filter((r) => r.kind === "batch")
  .map((row) => {
    const runtime = String(row.label).split("+")[0]!;
    const end = Date.parse(row.at);
    const start = end - row.batchMs - 1000;
    const inWindow = (e: Event): boolean => {
      const t = Date.parse(e.time);
      return t >= start && t <= end;
    };
    const events = (logs[runtime] ?? []).filter(inWindow);
    const otherRuntimeSteps = Object.entries(logs)
      .filter(([name]) => name !== runtime)
      .reduce(
        (n, [, list]) =>
          n +
          list.filter(
            (e) => e.eventType === "model.step.finished" && inWindow(e),
          ).length,
        0,
      );
    const slowestTool = new Map<string, number>();
    for (const e of events.filter(
      (x) => x.eventType === "tool.call.finished",
    )) {
      const key = `${e.eventId}#${e.stepNumber}`;
      slowestTool.set(key, Math.max(slowestTool.get(key) ?? 0, e.durationMs));
    }
    let steps = 0,
      modelMs = 0,
      toolMs = 0,
      input = 0,
      cacheRead = 0,
      cacheWrite = 0,
      output = 0;
    for (const e of events.filter(
      (x) => x.eventType === "model.step.finished",
    )) {
      const tool = slowestTool.get(`${e.eventId}#${e.stepNumber}`) ?? 0;
      steps += 1;
      toolMs += tool;
      modelMs += e.durationMs - tool;
      input += e.usage?.inputTokenDetails?.noCacheTokens ?? 0;
      cacheRead += e.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
      cacheWrite += e.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
      output += e.usage?.outputTokens ?? 0;
    }
    // One invocation per run (parent, subagent, follow-up), finished or failed
    // (a subagent its parent stopped): set against the audit rows.
    const runs = events.filter(
      (x) =>
        x.eventType === "model.invocation.finished" ||
        x.eventType === "model.invocation.failed",
    ).length;
    const usd =
      (input * PRICE.input +
        output * PRICE.output +
        cacheRead * PRICE.cacheRead +
        cacheWrite * PRICE.cacheWrite) /
      1e6;
    const n = row.level;

    return {
      label: row.label,
      level: n,
      at: row.at,
      ok: row.ok,
      failed: row.failed,
      p50: row.p50,
      stepsPerTask: steps / n,
      modelMsPerTask: modelMs / n,
      toolMsPerTask: toolMs / n,
      inputTokensPerTask: input / n,
      cacheReadPerTask: cacheRead / n,
      cacheWritePerTask: cacheWrite / n,
      outputTokensPerTask: output / n,
      usdPerTask: usd / n,
      otherRuntimeSteps: otherRuntimeSteps,
      runsLogged: runs,
    };
  });
for (const r of out) {
  console.log(
    `${r.label} @${r.level} ${r.at}: ok ${r.ok}/${r.level}, p50 ${Math.round(r.p50)} ms, steps/task ${r.stepsPerTask.toFixed(1)}, model ${Math.round(r.modelMsPerTask)} ms/task, tools ${Math.round(r.toolMsPerTask)} ms/task, tokens in ${Math.round(r.inputTokensPerTask)} + cache read ${Math.round(r.cacheReadPerTask)} + cache write ${Math.round(r.cacheWritePerTask)}, out ${Math.round(r.outputTokensPerTask)}, $${r.usdPerTask.toFixed(4)}/task, other runtimes' steps ${r.otherRuntimeSteps}, runs logged ${r.runsLogged}`,
  );
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`);
