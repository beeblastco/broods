/**
 * The gate's own behavior. A performance gate that silently stops failing is
 * worse than no gate, so the grading rules get tests of their own.
 */

import { describe, expect, it } from "bun:test";
import {
  compareToBaselines,
  type BenchBaselineFile,
  type BenchEnvironment,
  type BenchMeasurement,
} from "./runner.ts";

const SAME_MACHINE: BenchEnvironment = { platform: "linux", arch: "x64" };
const OTHER_MACHINE: BenchEnvironment = { platform: "darwin", arch: "arm64" };

const BASELINES: BenchBaselineFile = {
  recordedAt: "2026-09-04T00:00:00.000Z",
  bun: "1.4.0",
  platform: "linux",
  arch: "x64",
  policy: { defaultMaxRegressionPct: 30, noiseCeilingPct: 15 },
  cases: {
    "gated/case": { nsPerOp: 100, ceilingNs: 1_000, gate: "blocking" },
    "gated/tight": {
      nsPerOp: 100,
      ceilingNs: 1_000,
      gate: "blocking",
      maxRegressionPct: 5,
    },
    "watched/case": { nsPerOp: 100, ceilingNs: 1_000, gate: "informational" },
  },
};

// Enough gated cases for the suite's median drift to stand in for the host's
// clock, the way it does on a real run.
const SUITE_NAMES: readonly string[] = ["a", "b", "c", "d", "e", "f"].map(
  (letter) => `suite/${letter}`,
);
const SUITE_BASELINES: BenchBaselineFile = {
  ...BASELINES,
  cases: Object.fromEntries(
    SUITE_NAMES.map((name) => [
      name,
      { nsPerOp: 100, ceilingNs: 1_000, gate: "blocking" },
    ]),
  ),
};

describe("compareToBaselines", () => {
  it("passes a measurement inside the allowance", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 120 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("ok");
    expect(comparison?.failing).toBe(false);
  });

  it("fails a blocking case that drifts past the allowance", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 140 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("regressed");
    expect(comparison?.failing).toBe(true);
    expect(comparison?.deltaPct).toBeCloseTo(40, 5);
  });

  it("honours a per-case allowance over the policy default", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/tight", nsPerOp: 110 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("regressed");
    expect(comparison?.failing).toBe(true);
  });

  it("fails a blocking case over its product ceiling even without a baseline drift", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 1_500 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("over-ceiling");
    expect(comparison?.failing).toBe(true);
  });

  it("reports but never fails an informational case", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "watched/case", nsPerOp: 5_000 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("over-ceiling");
    expect(comparison?.failing).toBe(false);
  });

  it("refuses to convict on a measurement noisier than the ceiling", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 140, rsdPct: 22 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("noisy");
    expect(comparison?.failing).toBe(false);
  });

  it("reports drift without failing when the baseline is from another machine", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 140 })],
      BASELINES,
      OTHER_MACHINE,
    );

    expect(comparison?.status).toBe("regressed");
    expect(comparison?.failing).toBe(false);
    expect(comparison?.note).toContain("re-record here");
  });

  it("still enforces the product ceiling across machines", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 1_500 })],
      BASELINES,
      OTHER_MACHINE,
    );

    expect(comparison?.status).toBe("over-ceiling");
    expect(comparison?.failing).toBe(true);
  });

  it("treats an unknown case as new rather than as a pass or a failure", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "brand/new", nsPerOp: 100 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("new");
    expect(comparison?.failing).toBe(false);
    expect(comparison?.deltaPct).toBeNull();
  });

  it("does not convict a host that is uniformly slower than the baseline machine", () => {
    // Every case +45%: a slower runner in the same pool, not a code change.
    const { comparisons, machineRatio } = compareToBaselines(
      SUITE_NAMES.map((name) => measurement({ name: name, nsPerOp: 145 })),
      SUITE_BASELINES,
      SAME_MACHINE,
    );

    expect(machineRatio).toBeCloseTo(1.45, 5);
    expect(comparisons.every((comparison) => comparison.status === "ok")).toBe(
      true,
    );
  });

  it("still catches one path regressing on a uniformly slower host", () => {
    const { comparisons } = compareToBaselines(
      SUITE_NAMES.map((name, index) =>
        measurement({ name: name, nsPerOp: index === 0 ? 145 * 1.6 : 145 }),
      ),
      SUITE_BASELINES,
      SAME_MACHINE,
    );

    expect(comparisons[0]?.status).toBe("regressed");
    expect(comparisons[0]?.failing).toBe(true);
    expect(comparisons[0]?.deltaPct).toBeCloseTo(60, 5);
    expect(
      comparisons.slice(1).every((comparison) => comparison.status === "ok"),
    ).toBe(true);
  });

  it("judges against the raw clock when too few cases have baselines", () => {
    const { machineRatio } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 140 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(machineRatio).toBe(1);
  });

  it("flags a large improvement so the baseline gets re-recorded", () => {
    const {
      comparisons: [comparison],
    } = compareToBaselines(
      [measurement({ name: "gated/case", nsPerOp: 40 })],
      BASELINES,
      SAME_MACHINE,
    );

    expect(comparison?.status).toBe("improved");
    expect(comparison?.failing).toBe(false);
  });
});

function measurement(
  overrides: Partial<BenchMeasurement> & { name: string; nsPerOp: number },
): BenchMeasurement {
  return {
    minNsPerOp: overrides.nsPerOp,
    p95NsPerOp: overrides.nsPerOp,
    rsdPct: 2,
    bytesPerOp: 0,
    iterations: 1_000,
    samples: 21,
    ...overrides,
  };
}
