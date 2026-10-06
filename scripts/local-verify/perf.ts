/**
 * `local-stack perf`: what a turn costs Broods itself, with core started by
 * `up --perf` so the model answers in process. Convex calls per turn are
 * exact on any machine, so a scenario that makes more calls than
 * perf-baseline.json fails. Timings depend on the machine, so drift against
 * the same platform's baseline only warns.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertStep, connectMachine, type VerifyContext } from "./harness.ts";

const BASELINE_PATH = join(import.meta.dir, "perf-baseline.json");
const BURST_ROUNDS = 3;
const BURST_SIZE = 10;
const ITERATIONS = 20;
const QUIET_MS = 150;
const QUIET_TIMEOUT_MS = 3_000;
const TIMING_DRIFT_WARN = 1.3;
const WARMUP = 3;

interface PerfBaseline {
  convexCalls: Record<string, number>;
  timingsP50Ms: Record<string, Record<string, number>>;
}

interface ScenarioResult {
  calls?: { byFunction: Record<string, number>; total: number };
  name: string;
  p50: number;
  p95: number;
}

/** Runs every scenario, prints and summarizes it, and returns false when a Convex call budget grew. */
export async function runPerf(
  context: VerifyContext,
  options: { record: boolean; tracePath: string },
): Promise<boolean> {
  const machine = await connectMachine(context, {
    computer: false,
    name: `perf-machine-${context.runId}`,
  });
  try {
    const textAgent = await context.account.createAgent({
      name: `perf-text-${context.runId}`,
      config: { ...context.model, instructions: "Reply OK." },
    });
    const bashAgent = await context.account.createAgent({
      name: `perf-bash-${context.runId}`,
      config: {
        ...context.model,
        instructions: "Use bash.",
        sandboxes: [machine.sandboxId],
      },
    });
    const stream = async (
      agentId: string,
      key: string,
      input: string,
    ): Promise<number> => {
      const startedAt = performance.now();
      for await (const _part of context.client.agent("perf", agentId).stream({
        conversationKey: `${key}-${context.runId}`,
        eventId: `${key}-${context.runId}`,
        input: input,
      })) {
        continue;
      }

      return performance.now() - startedAt;
    };
    const failedRuns: string[] = [];
    for (let index = 0; index < WARMUP; index += 1) {
      await stream(textAgent.agentId, `warm-${index}`, "Say OK.");
    }

    const results: ScenarioResult[] = [
      await counted(options.tracePath, "sse text turn", (index) =>
        stream(textAgent.agentId, `text-${index}`, "Say OK."),
      ),
      await counted(options.tracePath, "sse bash tool turn", (index) =>
        stream(bashAgent.agentId, `bash-${index}`, "RUN_BASH"),
      ),
      await timed("async text run", async (index): Promise<number> => {
        const startedAt = performance.now();
        const accepted = await context.client.runAsync({
          agentId: textAgent.agentId,
          conversationKey: `async-${index}-${context.runId}`,
          eventId: `async-${index}-${context.runId}`,
          input: "Say OK.",
        });
        const status = await accepted.wait({
          intervalMs: 5,
          timeoutMs: 60_000,
        });
        if (status.status !== "completed") {
          failedRuns.push(JSON.stringify(status));
        }

        return performance.now() - startedAt;
      }),
    ];
    assertStep(
      "every async run completed",
      failedRuns.length === 0,
      failedRuns.join("\n"),
    );
    assertStep(
      "the bash turns ran on the machine",
      machine.output().includes("$ "),
      machine.output(),
    );
    const burst: number[] = [];
    for (let round = 0; round < BURST_ROUNDS; round += 1) {
      burst.push(
        ...(await Promise.all(
          Array.from({ length: BURST_SIZE }, (_, index): Promise<number> =>
            stream(textAgent.agentId, `burst-${round}-${index}`, "Say OK."),
          ),
        )),
      );
    }
    results.push({
      name: `sse text turn, ${BURST_SIZE} at once`,
      p50: percentile(burst, 0.5),
      p95: percentile(burst, 0.95),
    });

    return report(results, options.record);
  } finally {
    await machine.stop();
  }
}

/** Timed like `timed`, and counts the Convex calls each iteration made once core goes quiet. */
async function counted(
  tracePath: string,
  name: string,
  run: (index: number) => Promise<number>,
): Promise<ScenarioResult> {
  const timings: number[] = [];
  const calls: string[][] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const before = traceLines(tracePath).length;
    timings.push(await run(index));
    await waitForQuiet(tracePath);
    calls.push(
      traceLines(tracePath)
        .slice(before)
        .filter((fn): boolean => !fn.startsWith("sandbox/machines:")),
    );
  }
  const median = [...calls].sort(
    (left, right): number => left.length - right.length,
  )[Math.floor(calls.length / 2)]!;
  const byFunction: Record<string, number> = {};
  for (const fn of median) byFunction[fn] = (byFunction[fn] ?? 0) + 1;

  return {
    calls: { byFunction: byFunction, total: median.length },
    name: name,
    p50: percentile(timings, 0.5),
    p95: percentile(timings, 0.95),
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right): number => left - right);

  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Prints the table, appends it to the GitHub job summary, and records or grades against the baseline. */
function report(results: ScenarioResult[], record: boolean): boolean {
  const baseline = JSON.parse(
    readFileSync(BASELINE_PATH, "utf8"),
  ) as PerfBaseline;
  const platformTimings = baseline.timingsP50Ms[platformKey()] ?? {};
  const failures: string[] = [];
  const notes: string[] = [];
  const rows = results.map((result): string => {
    const baseP50 = platformTimings[result.name];
    const drift =
      baseP50 === undefined
        ? "no baseline"
        : `${(((result.p50 - baseP50) / baseP50) * 100).toFixed(0)}%${result.p50 > baseP50 * TIMING_DRIFT_WARN ? " warn" : ""}`;
    const budget = baseline.convexCalls[result.name];
    const calls = record ? undefined : result.calls;
    if (calls && budget === undefined) {
      failures.push(`${result.name}: no Convex call budget recorded`);
    } else if (calls && calls.total > (budget ?? 0)) {
      failures.push(
        `${result.name}: ${calls.total} Convex calls, budget ${budget}`,
      );
    } else if (calls && calls.total < (budget ?? 0)) {
      notes.push(
        `${result.name}: ${calls.total} Convex calls, under the budget of ${budget}; record to lock the gain in`,
      );
    }

    return `| ${result.name} | ${result.p50.toFixed(1)} | ${result.p95.toFixed(1)} | ${baseP50?.toFixed(1) ?? "-"} | ${drift} | ${result.calls?.total ?? "-"} | ${budget ?? "-"} |`;
  });
  const breakdown = results.flatMap((result): string[] =>
    result.calls
      ? [
          `<details><summary>${result.name}: Convex calls by function</summary>`,
          "",
          "| function | calls |",
          "| --- | --- |",
          ...Object.entries(result.calls.byFunction)
            .sort(([left], [right]): number => left.localeCompare(right))
            .map(([fn, count]): string => `| ${fn} | ${count} |`),
          "",
          "</details>",
          "",
        ]
      : [],
  );
  const markdown = [
    `### local-stack perf (${platformKey()}, model answered in process)`,
    "",
    "| scenario | p50 ms | p95 ms | baseline p50 | drift | Convex calls | budget |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...failures.map((failure): string => `- **fail** ${failure}`),
    ...notes.map((note): string => `- ${note}`),
    "",
    ...breakdown,
  ].join("\n");
  console.log(`\n${markdown}`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);

  if (record) {
    const next: PerfBaseline = {
      convexCalls: Object.fromEntries(
        results.flatMap((result): [string, number][] =>
          result.calls ? [[result.name, result.calls.total]] : [],
        ),
      ),
      timingsP50Ms: {
        ...baseline.timingsP50Ms,
        [platformKey()]: Object.fromEntries(
          results.map((result): [string, number] => [
            result.name,
            Number(result.p50.toFixed(1)),
          ]),
        ),
      },
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nrecorded ${BASELINE_PATH}`);

    return true;
  }

  return failures.length === 0;
}

/** Timings for ITERATIONS runs of one scenario. */
async function timed(
  name: string,
  run: (index: number) => Promise<number>,
): Promise<ScenarioResult> {
  const timings: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    timings.push(await run(index));
  }

  return {
    name: name,
    p50: percentile(timings, 0.5),
    p95: percentile(timings, 0.95),
  };
}

/** Every complete trace line; a line core is still appending has no newline yet and waits for the next read. */
function traceLines(tracePath: string): string[] {
  let text = "";
  try {
    text = readFileSync(tracePath, "utf8");
  } catch {
    return [];
  }

  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line): string => (JSON.parse(line) as { fn: string }).fn);
}

/** Waits until core has made no Convex call for QUIET_MS, so a run's tail writes count toward it. */
async function waitForQuiet(tracePath: string): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  let size = -1;
  while (Date.now() < deadline) {
    let next = 0;
    try {
      next = statSync(tracePath).size;
    } catch {
      next = 0;
    }
    if (next === size) return;
    size = next;
    await Bun.sleep(QUIET_MS);
  }
}
