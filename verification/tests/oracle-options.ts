// Seed and size for the Lean oracle tests: fixed on pull requests, so a run is reproducible;
// the nightly job sets `ORACLE_SEED` and `ORACLE_RUNS` to look further, and prints the seed.

const DEFAULT_SEED = 20261103;

const DEFAULT_RUNS = 5000;

/** Runs per oracle test: `ORACLE_RUNS`, or the pull request default. */
export function oracleRuns(): number {
  return positiveInt(process.env.ORACLE_RUNS) ?? DEFAULT_RUNS;
}

/** fast-check seed: `ORACLE_SEED`, or the fixed pull request seed. */
export function oracleSeed(): number {
  return positiveInt(process.env.ORACLE_SEED) ?? DEFAULT_SEED;
}

// `value` as a positive integer, or undefined when unset or not one.
function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
