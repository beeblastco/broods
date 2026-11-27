/**
 * Grades the perf specs' numbers against `e2e/perf/baseline.json` and writes the job summary.
 * Policy and the re-baseline rules: apps/dashboard/AGENTS.md, Perf baseline.
 */
import { expect, test } from "@playwright/test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { probeAccount } from "./session";

const BASELINE_FILE = join(__dirname, "..", "perf", "baseline.json");
const CANDIDATE_FILE = join(
  __dirname,
  "..",
  "..",
  "test-results",
  "perf-baseline.json",
);
const RECORD = process.env.E2E_RECORD_PERF === "1";

export interface PerfReading {
  value: number;
  /** Deterministic numbers block; timing moves with the machine, so it only flags. */
  gate: "blocking" | "informational";
  /** Growth allowed over the baseline: 0 for a count that must not grow. */
  maxRegressionPct: number;
  /** Absolute room on top, for a number that sits near zero. */
  slack?: number;
  /** A product budget that fails the run on any machine, whatever the gate. */
  ceiling?: number;
}

type Status = "improved" | "new" | "ok" | "regressed" | "ungraded";

interface Graded {
  name: string;
  reading: PerfReading;
  baseline: number | undefined;
  status: Status;
}

/** Grades one spec's readings, keyed `<spec>.<subject>.<metric>`, and reports them. */
export function checkPerfBaseline(
  title: string,
  readings: Record<string, PerfReading>,
): void {
  const values = Object.fromEntries(
    Object.entries(readings).map(([name, reading]) => [name, reading.value]),
  );
  const onStack = Boolean(probeAccount.adminKey);
  if (RECORD) {
    if (!onStack)
      throw new Error(
        "Record the perf baseline on the self-hosted stack (E2E_ADMIN_KEY)",
      );
    writeMerged(BASELINE_FILE, values);

    return;
  }
  if (onStack) writeMerged(CANDIDATE_FILE, values);

  const baseline = readNumbers(BASELINE_FILE);
  const graded = Object.entries(readings).map(([name, reading]) =>
    grade(name, reading, baseline[name], onStack),
  );
  report(title, graded);
  for (const row of graded) {
    if (row.reading.ceiling !== undefined) {
      expect
        .soft(row.reading.value, `${row.name}: product budget`)
        .toBeLessThanOrEqual(row.reading.ceiling);
    }
    if (row.reading.gate !== "blocking") continue;
    expect
      .soft(
        row.baseline,
        `${row.name}: no baseline; record one with E2E_RECORD_PERF=1`,
      )
      .toBeDefined();
    expect
      .soft(
        row.status,
        `${row.name}: ${row.reading.value} against a baseline of ${row.baseline}`,
      )
      .not.toBe("regressed");
  }
}

function grade(
  name: string,
  reading: PerfReading,
  baseline: number | undefined,
  onStack: boolean,
): Graded {
  const row = { name: name, reading: reading, baseline: baseline };
  if (baseline === undefined) return { ...row, status: "new" };
  // Timing off the stack waits on another backend than the baseline did.
  if (reading.gate === "informational" && !onStack)
    return { ...row, status: "ungraded" };
  const room = Math.max(
    baseline * (reading.maxRegressionPct / 100),
    reading.slack ?? 0,
  );
  if (reading.value > baseline + room) return { ...row, status: "regressed" };
  if (reading.value < baseline - room) return { ...row, status: "improved" };

  return { ...row, status: "ok" };
}

function readNumbers(file: string): Record<string, number> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// The job summary table, and a warning annotation for each flagged number.
function report(title: string, graded: Graded[]): void {
  const lines = [
    `### Perf: ${title}`,
    "",
    "| Metric | Baseline | Now | Change | Allowed | Status |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...graded.map((row) => {
      const change =
        row.baseline === undefined || row.baseline === 0
          ? ""
          : `${Math.round((row.reading.value / row.baseline - 1) * 100)}%`;
      const flag =
        row.status === "regressed"
          ? " ⚠"
          : row.status === "improved"
            ? " (re-record)"
            : "";

      return `| ${row.name} | ${row.baseline ?? "none"} | ${row.reading.value} | ${change} | +${row.reading.maxRegressionPct}%${row.reading.slack ? ` or ${row.reading.slack}` : ""} | ${row.status}${flag} |`;
    }),
    "",
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  for (const row of graded) {
    if (row.status === "regressed" && row.reading.gate === "informational") {
      console.log(
        `::warning title=Perf drift::${row.name} is ${row.reading.value}, baseline ${row.baseline}`,
      );
    }
  }
  void test.info().attach(`perf-${title}`, {
    body: JSON.stringify(graded, null, 2),
    contentType: "application/json",
  });
}

function writeMerged(file: string, values: Record<string, number>): void {
  const merged = { ...readNumbers(file), ...values };
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}
