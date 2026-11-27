import { spawnSync } from "node:child_process";
import { SUITES } from "../replay/suites/index.ts";
import type { Suite } from "../replay/suite.ts";

const ROOT = `${import.meta.dir}/../..`;
const PRELOAD = "./formal/replay/mutate-preload.ts";

interface TestRun {
  failed: number;
  passed: number;
  output: string;
}

// Runs replay once per injected fault, after a no-fault baseline. A fault that replay misses is a
// hole in the vectors, and a baseline that fails or runs no test makes every other result void.
function main(): void {
  const only = process.argv[2];
  const survivors: string[] = [];
  let caught = 0;
  for (const suite of SUITES) {
    if (suite.tests.length === 0 || (only && suite.name !== only)) continue;
    const baseline = runSuite(suite, undefined);
    if (baseline.passed === 0 || baseline.failed > 0) {
      throw new Error(`${suite.name} baseline must pass:\n${baseline.output}`);
    }
    for (const [index, mutation] of suite.mutations.entries()) {
      const run = runSuite(suite, index);
      if (run.output.includes("no longer matches")) {
        throw new Error(
          `fault "${mutation.name}" no longer matches its source`,
        );
      }
      if (run.passed + run.failed === 0) {
        throw new Error(`no test ran under "${mutation.name}":\n${run.output}`);
      }
      const hit = run.failed > 0;
      console.log(
        `${hit ? "caught  " : "SURVIVED"}  ${suite.name}: ${mutation.name}`,
      );
      if (hit) caught += 1;
      else survivors.push(`${suite.name}: ${mutation.name}`);
    }
  }
  console.log(`${caught} of ${caught + survivors.length} faults caught`);
  if (survivors.length > 0) process.exit(1);
}

function runSuite(suite: Suite, mutation: number | undefined): TestRun {
  const result = spawnSync(
    "bun",
    ["test", "--preload", PRELOAD, ...suite.tests],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      timeout: 600_000,
      env: {
        ...process.env,
        ...suite.env,
        SPEC_SUITE: suite.name,
        SPEC_MUTATION: mutation === undefined ? "" : String(mutation),
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;

  return {
    failed: Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0),
    passed: Number(/(\d+) pass\b/.exec(output)?.[1] ?? 0),
    output: output,
  };
}

main();
