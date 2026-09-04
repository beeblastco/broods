/**
 * The measurement engine and the baseline comparison behind `bun run bench`.
 *
 * Every case here is CPU-only: no network, no filesystem, no model call, no
 * clock the case itself does not control. That is what makes a CI number worth
 * gating on — the only thing left that moves it is the code under test and the
 * speed of the machine.
 */

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
  | "regressed";

/**
 * One measured hot path. `name` is the baseline key, so renaming a case orphans
 * its history: rename deliberately and re-record.
 */
export interface BenchCase {
  name: string;
  /** Calls per timed sample. Tune so one sample lands near 1-5 ms. */
  iterations: number;
  run: () => unknown;
  setup?: () => void;
  teardown?: () => void;
}

export interface BenchBaseline {
  /** Median ns/op recorded on the reference machine. */
  nsPerOp: number;
  /** Absolute product ceiling. A case slower than this fails regardless of drift. */
  ceilingNs: number;
  gate: BenchGate;
  /** Per-case override of the policy default, for paths with wider spread. */
  maxRegressionPct?: number;
}

export interface BenchBaselineFile {
  recordedAt: string;
  bun: string;
  /**
   * The machine the ns/op numbers came from. Drift is only compared when the
   * run matches it: a laptop baseline says nothing about a CI runner's clock,
   * and a gate that pretends otherwise fails on hardware, not on code.
   */
  platform: string;
  arch: string;
  policy: BenchPolicy;
  cases: Record<string, BenchBaseline>;
}

/** The machine a comparison is running on, matched against the baseline's. */
export interface BenchEnvironment {
  platform: string;
  arch: string;
}

export interface BenchPolicy {
  /** Slowdown a case may absorb before a blocking gate trips. */
  defaultMaxRegressionPct: number;
  /**
   * Run-to-run spread above which a case's own number is not trusted. A noisy
   * case never fails CI; it reports as `noisy` so the flakiness is visible
   * instead of being papered over by a looser threshold.
   */
  noiseCeilingPct: number;
}

export interface BenchMeasurement {
  name: string;
  /** Median across samples. The gated number: robust to a single slow sample. */
  nsPerOp: number;
  minNsPerOp: number;
  p95NsPerOp: number;
  /** Relative standard deviation across samples, in percent. */
  rsdPct: number;
  /** Heap growth per op. Informational: GC timing makes it too coarse to gate. */
  bytesPerOp: number;
  iterations: number;
  samples: number;
}

export interface BenchComparison {
  measurement: BenchMeasurement;
  baseline: BenchBaseline | null;
  status: BenchStatus;
  /**
   * Drift relative to the run's machine ratio, in percent. Positive means this
   * case slowed down more than the suite as a whole did. Null without a baseline.
   */
  deltaPct: number | null;
  /** Whether this comparison should fail the run. */
  failing: boolean;
  note: string;
}

export interface BenchGrading {
  comparisons: BenchComparison[];
  /**
   * How much slower this run's machine is than the one the baselines were
   * recorded on: the median of measured/baseline across every gated case. A
   * hosted CI pool varies well over 1.3x between hosts, so drift is judged
   * against this rather than against the raw clock.
   */
  machineRatio: number;
}

export interface BenchResultFile {
  ranAt: string;
  bun: string;
  platform: string;
  arch: string;
  cpus: number;
  measurements: BenchMeasurement[];
}

/**
 * Grade every measurement against the committed baselines. Nothing is written
 * here: a baseline only changes through an explicit, reviewed `--record`.
 */
export function compareToBaselines(
  measurements: readonly BenchMeasurement[],
  baselines: BenchBaselineFile,
  environment: BenchEnvironment,
): BenchGrading {
  // Ceilings are product statements and hold on any machine fit to serve
  // traffic. Drift is a comparison against a recorded clock, so it only carries
  // weight on the hardware class that clock was recorded on: a different arch
  // shifts the paths unevenly (hardware SHA-256, regex engines) and the
  // machine ratio below cannot cancel that.
  const driftComparable =
    baselines.platform === environment.platform &&
    baselines.arch === environment.arch;

  // Within one hardware class, hosts still differ in clock. A slower host slows
  // every case by about the same factor, and a code regression slows one. So
  // the ratio the suite as a whole moved by is the machine, and each case is
  // judged against that rather than against the recorded nanoseconds.
  const machineRatio = medianDriftRatio(measurements, baselines);

  const comparisons = measurements.map((measurement): BenchComparison => {
    const baseline = baselines.cases[measurement.name] ?? null;
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
    const regressed = deltaPct > maxRegressionPct;

    // A case whose own samples disagree cannot convict the code under test.
    // Report the noise rather than widening the threshold until it fits.
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

  return { comparisons: comparisons, machineRatio: machineRatio };
}

/** Time one case: warmup samples discarded, then a median over `samples`. */
export function measureCase(
  benchCase: BenchCase,
  samples: number = DEFAULT_SAMPLES,
): BenchMeasurement {
  benchCase.setup?.();
  try {
    for (let sample = 0; sample < WARMUP_SAMPLES; sample += 1) {
      timeSample(benchCase);
    }

    const timings: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      // Collect between samples, never inside one. An allocation-heavy case
      // otherwise has a full GC land in a random sample and read as a spike in
      // the code under test rather than as the cost of measuring it.
      Bun.gc(true);
      timings.push(timeSample(benchCase));
    }
    timings.sort((left, right) => left - right);

    return {
      name: benchCase.name,
      nsPerOp: median(timings),
      minNsPerOp: timings[0]!,
      p95NsPerOp: percentile(timings, 95),
      rsdPct: robustSpreadPct(timings),
      bytesPerOp: measureBytesPerOp(benchCase),
      iterations: benchCase.iterations,
      samples: samples,
    };
  } finally {
    benchCase.teardown?.();
  }
}

/** Run the whole suite in declaration order, reporting progress as it goes. */
export function measureCases(
  cases: readonly BenchCase[],
  onProgress?: (measurement: BenchMeasurement) => void,
): BenchMeasurement[] {
  const measurements: BenchMeasurement[] = [];
  for (const benchCase of cases) {
    const measurement = measureCase(benchCase);
    measurements.push(measurement);
    onProgress?.(measurement);
  }

  return measurements;
}

/** Render a duration the way the report and the baselines both read it. */
export function formatNs(nanoseconds: number): string {
  if (nanoseconds >= 1_000_000)
    return `${(nanoseconds / 1_000_000).toFixed(2)}ms`;
  if (nanoseconds >= 1_000) return `${(nanoseconds / 1_000).toFixed(2)}us`;

  return `${nanoseconds.toFixed(1)}ns`;
}

/**
 * A single accumulator every case's return value lands in, so the optimizer
 * cannot delete the call it is supposed to be timing.
 */
let sink = 0;

/** Read and reset the sink. Only exists so the value is observably used. */
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

/**
 * Heap growth per op, measured over its own pass with GC forced on both sides.
 * Coarse by construction — reported, never gated.
 */
function measureBytesPerOp(benchCase: BenchCase): number {
  const iterations = Math.min(
    BYTES_PER_OP_ITERATION_CAP,
    Math.max(benchCase.iterations, BYTES_PER_OP_ITERATION_FLOOR),
  );
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    consume(benchCase.run());
  }
  const after = process.memoryUsage().heapUsed;
  Bun.gc(true);

  return Math.max(0, (after - before) / iterations);
}

/**
 * The factor the suite as a whole moved by since the baselines were recorded.
 * With too few gated cases the median says nothing, so the ratio is 1 and drift
 * is judged against the raw clock.
 */
function medianDriftRatio(
  measurements: readonly BenchMeasurement[],
  baselines: BenchBaselineFile,
): number {
  const ratios = measurements
    .flatMap((measurement) => {
      const baseline = baselines.cases[measurement.name];

      return baseline ? [measurement.nsPerOp / baseline.nsPerOp] : [];
    })
    .sort((left, right) => left - right);
  if (ratios.length < MACHINE_RATIO_MIN_CASES) return 1;

  return median(ratios);
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;

  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(sorted: readonly number[], target: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((target / 100) * sorted.length) - 1,
  );

  return sorted[Math.max(0, index)]!;
}

/**
 * Spread of the samples around their median, as a percentage of it.
 *
 * Median absolute deviation rather than standard deviation: one descheduled
 * sample skews a standard deviation badly enough to mark a stable case noisy,
 * and the question the gate asks is whether the median it is about to compare
 * is reproducible. Scaled by 1.4826 so the number stays readable as "roughly a
 * standard deviation" for a normally distributed case.
 */
function robustSpreadPct(sorted: readonly number[]): number {
  const centre = median(sorted);
  if (centre === 0) return 0;
  const deviations = sorted
    .map((timing) => Math.abs(timing - centre))
    .sort((left, right) => left - right);

  return ((median(deviations) * 1.4826) / centre) * 100;
}

function timeSample(benchCase: BenchCase): number {
  const startedAt = Bun.nanoseconds();
  for (let iteration = 0; iteration < benchCase.iterations; iteration += 1) {
    consume(benchCase.run());
  }

  return (Bun.nanoseconds() - startedAt) / benchCase.iterations;
}
