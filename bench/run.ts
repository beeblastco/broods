/**
 * `bun run bench` — measure the suite and print it.
 * `bun run bench:check` — measure, grade against bench/baselines.json, exit 1
 *   on a blocking regression. This is what CI runs.
 * `bun run bench:record` — overwrite the baselines from a fresh measurement.
 *   Never called by CI: a baseline moves only through a reviewed commit.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allCases } from "./cases/index.ts";
import {
  compareToBaselines,
  formatNs,
  measureCases,
  type BenchBaselineFile,
  type BenchComparison,
  type BenchMeasurement,
  type BenchResultFile,
} from "./runner.ts";

const BASELINES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "baselines.json",
);
const DEFAULT_CEILING_MULTIPLIER = 3;
const STATUS_MARKS: Readonly<Record<string, string>> = {
  improved: "FASTER",
  new: "NEW",
  noisy: "NOISY",
  ok: "ok",
  "over-ceiling": "CEILING",
  regressed: "SLOWER",
  skipped: "SKIPPED",
};

const args = new Set(process.argv.slice(2));
const mode = args.has("--record")
  ? "record"
  : args.has("--check")
    ? "check"
    : "run";

// `--only <prefix>` runs a slice of the suite while iterating on a case; a
// partial run is never graded or recorded, since the machine ratio needs the
// whole suite to mean anything.
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : (process.argv[onlyIndex + 1] ?? null);
const selectedCases =
  only === null
    ? allCases
    : allCases.filter((benchCase) => benchCase.name.startsWith(only));
if (only !== null && mode !== "run") {
  console.error(
    "--only is for `bun run bench`; check and record need the whole suite",
  );
  process.exit(2);
}

const measurements = await measureCases(selectedCases, (measurement) => {
  process.stderr.write(
    measurement.skipped
      ? `  skipped ${measurement.name}\n`
      : `  measured ${measurement.name} (${formatNs(measurement.nsPerOp)}/op)\n`,
  );
});

const result: BenchResultFile = {
  ranAt: new Date().toISOString(),
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  cpus: availableParallelism(),
  measurements: measurements,
};

const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1) {
  const outPath = process.argv[outIndex + 1];
  if (!outPath) {
    console.error("--out needs a path");
    process.exit(2);
  }
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (mode === "record") {
  writeFileSync(
    BASELINES_PATH,
    `${JSON.stringify(recordBaselines(measurements), null, 2)}\n`,
  );
  console.log(
    `\nRecorded ${measurements.length} baselines to bench/baselines.json.`,
  );
  console.log(
    "Review the diff before committing: this is the only way a gate moves.",
  );
  process.exit(0);
}

if (mode === "run") {
  printMeasurements(result);
  process.exit(0);
}

if (!existsSync(BASELINES_PATH)) {
  console.error(
    "bench/baselines.json is missing. Run `bun run bench:record` first.",
  );
  process.exit(2);
}

const baselines = JSON.parse(
  readFileSync(BASELINES_PATH, "utf8"),
) as BenchBaselineFile;
const { comparisons, machineRatio } = compareToBaselines(
  measurements,
  baselines,
  { platform: result.platform, arch: result.arch },
);
printComparisons(result, comparisons, machineRatio);

const failures = comparisons.filter((comparison) => comparison.failing);
if (failures.length > 0) {
  console.error(
    `\n${failures.length} blocking performance regression${failures.length === 1 ? "" : "s"}:`,
  );
  for (const failure of failures) {
    console.error(`  ${failure.measurement.name}: ${failure.note}`);
  }
  console.error(
    "\nIf the slowdown is intended, re-record with `bun run bench:record` and explain it in the PR.",
  );
  process.exit(1);
}

console.log("\nNo blocking performance regressions.");

function printComparisons(
  resultFile: BenchResultFile,
  graded: readonly BenchComparison[],
  machineRatio: number,
): void {
  printHeader(resultFile);
  console.log(
    `This host runs ${machineRatio.toFixed(2)}x the baseline clock; delta is drift beyond that.\n`,
  );
  console.log(
    `${"case".padEnd(38)}${"ns/op".padStart(12)}${"baseline".padStart(12)}${"delta".padStart(10)}${"spread".padStart(9)}  status`,
  );
  for (const comparison of graded) {
    const { measurement: measured, baseline, deltaPct } = comparison;
    console.log(
      measured.name.padEnd(38) +
        formatNs(measured.nsPerOp).padStart(12) +
        (baseline ? formatNs(baseline.nsPerOp) : "-").padStart(12) +
        (deltaPct === null
          ? "-"
          : `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`
        ).padStart(10) +
        `${measured.rsdPct.toFixed(1)}%`.padStart(9) +
        `  ${STATUS_MARKS[comparison.status] ?? comparison.status}` +
        (comparison.note ? ` (${comparison.note})` : ""),
    );
  }
}

function printHeader(resultFile: BenchResultFile): void {
  console.log(
    `\nBun ${resultFile.bun} on ${resultFile.platform}/${resultFile.arch}, ${resultFile.cpus} cpus, ${resultFile.ranAt}\n`,
  );
}

function printMeasurements(resultFile: BenchResultFile): void {
  printHeader(resultFile);
  console.log(
    `${"case".padEnd(38)}${"ns/op".padStart(12)}${"min".padStart(12)}${"p95".padStart(12)}${"spread".padStart(9)}${"cpu/op".padStart(11)}${"bytes/op".padStart(11)}`,
  );
  for (const measured of resultFile.measurements) {
    if (measured.skipped) {
      console.log(`${measured.name.padEnd(38)}${"skipped".padStart(12)}`);
      continue;
    }
    console.log(
      measured.name.padEnd(38) +
        formatNs(measured.nsPerOp).padStart(12) +
        formatNs(measured.minNsPerOp).padStart(12) +
        formatNs(measured.p95NsPerOp).padStart(12) +
        `${measured.rsdPct.toFixed(1)}%`.padStart(9) +
        formatNs(measured.cpuUsPerOp * 1_000).padStart(11) +
        measured.bytesPerOp.toFixed(0).padStart(11),
    );
  }
}

/**
 * Build a baselines file from a measurement run, carrying forward each case's
 * existing gate and ceiling so re-recording a number never quietly relaxes the
 * policy that was reviewed with it.
 */
function recordBaselines(
  measured: readonly BenchMeasurement[],
): BenchBaselineFile {
  const previous: BenchBaselineFile | null = existsSync(BASELINES_PATH)
    ? (JSON.parse(readFileSync(BASELINES_PATH, "utf8")) as BenchBaselineFile)
    : null;

  const cases: BenchBaselineFile["cases"] = {};
  for (const measurement of measured) {
    const prior = previous?.cases[measurement.name];
    // A case that could not run here has no number to record. Keep whatever
    // baseline it already had rather than overwriting it with a zero.
    if (measurement.skipped) {
      if (prior) cases[measurement.name] = prior;
      continue;
    }
    cases[measurement.name] = {
      nsPerOp: Number(measurement.nsPerOp.toFixed(1)),
      ceilingNs:
        prior?.ceilingNs ??
        Number((measurement.nsPerOp * DEFAULT_CEILING_MULTIPLIER).toFixed(0)),
      gate: prior?.gate ?? "informational",
      ...(prior?.maxRegressionPct !== undefined
        ? { maxRegressionPct: prior.maxRegressionPct }
        : {}),
    };
  }

  return {
    recordedAt: new Date().toISOString(),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    policy: previous?.policy ?? {
      defaultMaxRegressionPct: 40,
      noiseCeilingPct: 12,
    },
    cases: cases,
  };
}
