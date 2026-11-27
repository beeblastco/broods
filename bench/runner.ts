const BYTES_PER_OP_ITERATION_CAP = 20_000;
const BYTES_PER_OP_ITERATION_FLOOR = 1_000;
const DEFAULT_SAMPLES = 21;
const MACHINE_RATIO_MIN_CASES = 5;
const WARMUP_SAMPLES = 3;

export type BenchGate = "blocking" | "informational";
export type BenchStatus =
  | "improved"
  | "new"
  | "noisy"
  | "ok"
  | "over-ceiling"
  | "regressed"
  | "skipped";

export interface BenchCase {
  /** Baseline key: a rename orphans the case's history, so re-record. */
  name: string;
  /** Tune so one sample lands near 1-5 ms. */
  iterations: number;
  /** Set only on a slow case (a spawn, a socket): bytes/op then measures one sample. */
  samples?: number;
  run: () => unknown;
  available?: () => boolean;
  setup?: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

export interface BenchBaseline {
  nsPerOp: number;
  ceilingNs: number;
  gate: BenchGate;
  maxRegressionPct?: number;
}

export interface BenchBaselineFile {
  recordedAt: string;
  bun: string;
  platform: string;
  arch: string;
  policy: BenchPolicy;
  cases: Record<string, BenchBaseline>;
}

export interface BenchEnvironment {
  platform: string;
  arch: string;
}

export interface BenchPolicy {
  defaultMaxRegressionPct: number;
  noiseCeilingPct: number;
}

export interface BenchMeasurement {
  name: string;
  nsPerOp: number;
  minNsPerOp: number;
  p95NsPerOp: number;
  rsdPct: number;
  bytesPerOp: number;
  cpuUsPerOp: number;
  iterations: number;
  samples: number;
  skipped?: boolean;
}

export interface BenchComparison {
  measurement: BenchMeasurement;
  baseline: BenchBaseline | null;
  status: BenchStatus;
  deltaPct: number | null;
  failing: boolean;
  note: string;
}

export interface BenchGrading {
  comparisons: BenchComparison[];
  machineRatio: number;
  orphaned: string[];
}

export interface BenchResultFile {
  ranAt: string;
  bun: string;
  platform: string;
  arch: string;
  cpus: number;
  measurements: BenchMeasurement[];
}

export function compareToBaselines(
  measurements: readonly BenchMeasurement[],
  baselines: BenchBaselineFile,
  environment: BenchEnvironment,
): BenchGrading {
  // Ceilings hold on any machine; drift only on the hardware class it was recorded on,
  // since another arch shifts paths unevenly (hardware SHA-256, regex engines).
  const driftComparable =
    baselines.platform === environment.platform &&
    baselines.arch === environment.arch;

  // Hosts in one pool differ by over 1.3x, moving every case alike; a regression moves one.
  const machineRatio = medianDriftRatio(measurements, baselines);

  const comparisons = measurements.map((measurement): BenchComparison => {
    const baseline = baselines.cases[measurement.name] ?? null;
    if (measurement.skipped) {
      return {
        measurement: measurement,
        baseline: baseline,
        status: "skipped",
        deltaPct: null,
        failing: false,
        note: "runtime this case needs is not available here",
      };
    }
    if (!baseline) {
      return {
        measurement: measurement,
        baseline: null,
        status: "new",
        deltaPct: null,
        failing: false,
        note: "no baseline recorded; run with --record to adopt this number",
      };
    }

    const deltaPct =
      (measurement.nsPerOp / baseline.nsPerOp / machineRatio - 1) * 100;
    const maxRegressionPct =
      baseline.maxRegressionPct ?? baselines.policy.defaultMaxRegressionPct;
    const blocking = baseline.gate === "blocking";
    const overCeiling = measurement.nsPerOp > baseline.ceilingNs;
    // The median ratio cannot know which paths lagged: slower only if slower by both clocks.
    const rawDeltaPct = (measurement.nsPerOp / baseline.nsPerOp - 1) * 100;
    const regressed = Math.min(deltaPct, rawDeltaPct) > maxRegressionPct;

    // Noise only inflates a sample: a fastest sample over the ceiling is the regression itself.
    if (measurement.minNsPerOp > baseline.ceilingNs) {
      return {
        measurement: measurement,
        baseline: baseline,
        status: "over-ceiling",
        deltaPct: deltaPct,
        failing: blocking,
        note: `fastest sample ${formatNs(measurement.minNsPerOp)} over the ${formatNs(baseline.ceilingNs)} product ceiling`,
      };
    }

    if (
      (overCeiling || regressed) &&
      measurement.rsdPct > baselines.policy.noiseCeilingPct
    ) {
      return {
        measurement: measurement,
        baseline: baseline,
        status: "noisy",
        deltaPct: deltaPct,
        failing: false,
        note: `spread ${measurement.rsdPct.toFixed(1)}% exceeds the ${baselines.policy.noiseCeilingPct}% noise ceiling; result not trusted`,
      };
    }

    if (overCeiling) {
      return {
        measurement: measurement,
        baseline: baseline,
        status: "over-ceiling",
        deltaPct: deltaPct,
        failing: blocking,
        note: `${formatNs(measurement.nsPerOp)} over the ${formatNs(baseline.ceilingNs)} product ceiling`,
      };
    }

    if (regressed) {
      return {
        measurement: measurement,
        baseline: baseline,
        status: "regressed",
        deltaPct: deltaPct,
        failing: blocking && driftComparable,
        note: driftComparable
          ? `+${deltaPct.toFixed(1)}% over the ${maxRegressionPct}% allowance`
          : `+${deltaPct.toFixed(1)}%, but the baseline is from ${baselines.platform}/${baselines.arch}; re-record here to gate drift`,
      };
    }

    if (deltaPct < -maxRegressionPct) {
      return {
        measurement: measurement,
        baseline: baseline,
        status: "improved",
        deltaPct: deltaPct,
        failing: false,
        note: "faster than baseline; re-record to lock the gain in",
      };
    }

    return {
      measurement: measurement,
      baseline: baseline,
      status: "ok",
      deltaPct: deltaPct,
      failing: false,
      note: "",
    };
  });

  const measured = new Set(measurements.map((measurement) => measurement.name));
  const orphaned = Object.keys(baselines.cases).filter(
    (name) => !measured.has(name),
  );

  return {
    comparisons: comparisons,
    machineRatio: machineRatio,
    orphaned: orphaned,
  };
}

export async function measureCase(
  benchCase: BenchCase,
): Promise<BenchMeasurement> {
  const samples = benchCase.samples ?? DEFAULT_SAMPLES;
  if (benchCase.available && !benchCase.available()) {
    return {
      name: benchCase.name,
      nsPerOp: 0,
      minNsPerOp: 0,
      p95NsPerOp: 0,
      rsdPct: 0,
      bytesPerOp: 0,
      cpuUsPerOp: 0,
      iterations: benchCase.iterations,
      samples: samples,
      skipped: true,
    };
  }

  await benchCase.setup?.();
  try {
    for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
      await timeSample(benchCase);
    }

    const timings: number[] = [];
    let cpuUs = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      // GC between samples, never inside one, so a collection does not read as the case's cost.
      Bun.gc(true);
      const cpuBefore = process.cpuUsage();
      timings.push(await timeSample(benchCase));
      const cpu = process.cpuUsage(cpuBefore);
      cpuUs += cpu.user + cpu.system;
    }
    timings.sort((left, right) => left - right);

    return {
      name: benchCase.name,
      nsPerOp: median(timings),
      minNsPerOp: timings[0]!,
      p95NsPerOp: percentile(timings, 95),
      rsdPct: robustSpreadPct(timings),
      bytesPerOp: await measureBytesPerOp(benchCase),
      cpuUsPerOp: cpuUs / (samples * benchCase.iterations),
      iterations: benchCase.iterations,
      samples: samples,
    };
  } finally {
    await benchCase.teardown?.();
  }
}

export async function measureCases(
  cases: readonly BenchCase[],
  onProgress?: (measurement: BenchMeasurement) => void,
): Promise<BenchMeasurement[]> {
  const measurements: BenchMeasurement[] = [];
  for (const benchCase of cases) {
    const measurement = await measureCase(benchCase);
    measurements.push(measurement);
    onProgress?.(measurement);
  }

  return measurements;
}

export function formatNs(nanoseconds: number): string {
  if (nanoseconds >= 1_000_000)
    return `${(nanoseconds / 1_000_000).toFixed(2)}ms`;
  if (nanoseconds >= 1_000) return `${(nanoseconds / 1_000).toFixed(2)}us`;

  return `${nanoseconds.toFixed(1)}ns`;
}

// Every result lands here so the optimizer cannot delete the call being timed.
let sink = 0;

export function drainSink(): number {
  const drained = sink;
  sink = 0;

  return drained;
}

function consume(value: unknown): void {
  if (value === undefined || value === null) {
    sink += 1;

    return;
  }
  if (typeof value === "number") {
    sink += value === 0 ? 0 : 1;

    return;
  }
  if (typeof value === "string") {
    sink += value.length === 0 ? 0 : 1;

    return;
  }
  if (typeof value === "boolean") {
    sink += value ? 1 : 0;

    return;
  }
  if (Array.isArray(value)) {
    sink += value.length === 0 ? 0 : 1;

    return;
  }
  sink += 1;
}

async function measureBytesPerOp(benchCase: BenchCase): Promise<number> {
  const iterations =
    benchCase.samples === undefined
      ? Math.min(
          BYTES_PER_OP_ITERATION_CAP,
          Math.max(benchCase.iterations, BYTES_PER_OP_ITERATION_FLOOR),
        )
      : benchCase.iterations;
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const result = benchCase.run();
    consume(result instanceof Promise ? await result : result);
  }
  const after = process.memoryUsage().heapUsed;
  Bun.gc(true);

  return Math.max(0, (after - before) / iterations);
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;

  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianDriftRatio(
  measurements: readonly BenchMeasurement[],
  baselines: BenchBaselineFile,
): number {
  const ratios = measurements
    .flatMap((measurement) => {
      const baseline = baselines.cases[measurement.name];

      return baseline && !measurement.skipped
        ? [measurement.nsPerOp / baseline.nsPerOp]
        : [];
    })
    .sort((left, right) => left - right);
  if (ratios.length < MACHINE_RATIO_MIN_CASES) return 1;

  return median(ratios);
}

function percentile(sorted: readonly number[], target: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((target / 100) * sorted.length) - 1,
  );

  return sorted[Math.max(0, index)]!;
}

// MAD, not stddev: one descheduled sample would mark a stable case noisy.
// Scaled by 1.4826 so it reads as one stddev for a normal distribution.
function robustSpreadPct(sorted: readonly number[]): number {
  const centre = median(sorted);
  if (centre === 0) return 0;
  const deviations = sorted
    .map((timing) => Math.abs(timing - centre))
    .sort((left, right) => left - right);

  return ((median(deviations) * 1.4826) / centre) * 100;
}

// Await only real promises: awaiting a plain value costs a ~30 ns microtask.
async function timeSample(benchCase: BenchCase): Promise<number> {
  const startedAt = Bun.nanoseconds();
  for (let iteration = 0; iteration < benchCase.iterations; iteration += 1) {
    const result = benchCase.run();
    consume(result instanceof Promise ? await result : result);
  }

  return (Bun.nanoseconds() - startedAt) / benchCase.iterations;
}
