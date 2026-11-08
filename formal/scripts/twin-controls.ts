import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAULTS } from "../replay/twin-faults.ts";
import { ROOT } from "./functions.ts";

const OUT = join(ROOT, "formal/.lake/conform");
const TRACES = join(OUT, "traces");
const PRELOAD = join(ROOT, "formal/replay/record-preload.ts");
const SAMPLE = 60;

interface Line {
  fn: string;
  args: unknown[];
  self: unknown;
  effects: { fn: string; args: unknown; outcome: unknown }[];
  outcome: { returned?: unknown; threw?: unknown };
  hits: number[];
}

interface Result {
  source: string;
  traced: boolean;
  compared: number;
  mismatches: number;
}

type Damage = (line: Line) => Line | undefined;

const DAMAGES: Record<string, Damage> = {
  "drop an effect": (line) =>
    line.effects.length === 0
      ? undefined
      : { ...line, effects: line.effects.slice(1) },
  "change an effect's arguments": (line) =>
    line.effects.length === 0
      ? undefined
      : {
          ...line,
          effects: line.effects.map((effect, index) =>
            index === 0 ? { ...effect, args: ["__control__"] } : effect,
          ),
        },
  "rename an effect": (line) =>
    line.effects.length === 0
      ? undefined
      : {
          ...line,
          effects: line.effects.map((effect, index) =>
            index === 0 ? { ...effect, fn: `${effect.fn}__control` } : effect,
          ),
        },
  "change the result": (line) => ({
    ...line,
    outcome:
      "threw" in line.outcome
        ? { threw: "__control__" }
        : { returned: { control: "__control__" } },
  }),
};

// Shows that the comparison can fail. Each kind of damage to a recording must be caught for every
// sampled twin, and each source fault in `twin-faults.ts` must make its twin disagree when the
// tests run again against the faulty code, with the same tests passing cleanly first.
function main(): void {
  const twins = readResults().filter(
    (twin) => twin.traced && twin.compared > 0,
  );
  const sample = twins.slice(0, SAMPLE);
  let failed = 0;
  let caught = 0;
  for (const [name, damage] of Object.entries(DAMAGES)) {
    for (const twin of sample) {
      const verdict = damagedVerdict(twin.source, damage);
      if (verdict === undefined) continue;
      if (verdict) caught += 1;
      else {
        failed += 1;
        console.log(`MISSED ${name}: ${twin.source}`);
      }
    }
  }
  console.log(`${caught} damaged recordings caught`);
  for (const fault of FAULTS) {
    const clean = runFault(fault, false);
    const faulty = runFault(fault, true);
    if (
      clean.mismatches > 0 ||
      clean.compared === 0 ||
      faulty.mismatches === 0
    ) {
      failed += 1;
      console.log(
        `FAULT NOT CAUGHT ${fault.name}: clean ${clean.compared}/${clean.mismatches}, faulty ${faulty.compared}/${faulty.mismatches}`,
      );
    } else {
      caught += 1;
      console.log(`caught ${fault.name}`);
    }
  }
  console.log(`${caught} caught, ${failed} missed`);
  if (failed > 0) process.exit(1);
}

function readResults(): Result[] {
  const parsed = JSON.parse(
    readFileSync(join(OUT, "results.json"), "utf8"),
  ) as { twins: Result[] };

  return parsed.twins;
}

function damagedVerdict(source: string, damage: Damage): boolean | undefined {
  const encoded = `${encodeURIComponent(source)}.jsonl`;
  const path = join(TRACES, encoded);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line)
    .map(damage)
    .filter((line): line is Line => line !== undefined);
  if (lines.length === 0) return undefined;
  const directory = mkdtempSync(join(tmpdir(), "spec-twin-control-"));
  writeFileSync(
    join(directory, encoded),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  const result = conform(source, directory);
  rmSync(directory, { recursive: true, force: true });

  return result.mismatches > 0;
}

function conform(source: string, traces: string): Result {
  spawnSync(
    "bun",
    [
      "formal/scripts/conform.ts",
      "--reuse",
      `--traces=${traces}`,
      `--only=${source}`,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 },
  );
  const parsed = JSON.parse(
    readFileSync(join(OUT, "results-control.json"), "utf8"),
  ) as { twins: Result[] };

  return (
    parsed.twins[0] ?? {
      source: source,
      traced: true,
      compared: 0,
      mismatches: 0,
    }
  );
}

function runFault(fault: (typeof FAULTS)[number], active: boolean): Result {
  const directory = mkdtempSync(join(tmpdir(), "spec-twin-fault-"));
  const corpus = join(directory, "corpus");
  const traces = join(directory, "traces");
  mkdirSync(corpus);
  mkdirSync(traces);
  const sources = join(directory, "sources.txt");
  writeFileSync(sources, fault.twin);
  const run = spawnSync("bun", ["test", "--preload", PRELOAD, ...fault.tests], {
    cwd: join(ROOT, fault.cwd),
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: {
      ...process.env,
      SPEC_CORPUS: corpus,
      SPEC_TRACES: traces,
      SPEC_RECORD_SOURCES: sources,
      ...(active
        ? {
            SPEC_FAULT_FILE: fault.file,
            SPEC_FAULT_FIND: fault.find,
            SPEC_FAULT_REPLACE: fault.replace,
          }
        : {}),
    },
  });
  if (run.status === null) console.log(`  run did not finish: ${fault.name}`);
  const result = conform(fault.twin, traces);
  rmSync(directory, { recursive: true, force: true });

  return result;
}

main();
