import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAULTS } from "../replay/twin-faults.ts";
import { ROOT } from "./functions.ts";
import { JOBS, launch, pooled } from "./pool.ts";

const OUT = join(ROOT, "formal/.lake/conform");
const TRACES = join(OUT, "traces");
const PRELOAD = join(ROOT, "formal/replay/record-preload.ts");
const SAMPLE = 60;
const MAX_SAMPLED_TRACE_BYTES = 4_000_000;
const FAULT_RUN_LIMIT_MS = 180_000;

interface Line {
  fn: string;
  moduleAfter?: unknown;
  overlapped?: boolean;
  argsAfter?: unknown[];
  selfAfter?: unknown;
  args: unknown[];
  self: unknown;
  effects: { fn: string; args: unknown; outcome: unknown }[];
  outcome: { returned?: unknown; threw?: unknown };
  hits: number[];
}

interface Result {
  source: string;
  internal: string[];
  external: string[];
  traced: boolean;
  compared: number;
  mismatches: number;
  stateUnmodelled: number;
}

type Damage = (line: Line) => Line | undefined;

const DAMAGES: Record<string, Damage> = {
  "drop an effect": (line) => {
    const target = firstEffect(line);

    return target === -1
      ? undefined
      : {
          ...line,
          effects: line.effects.filter((_, index) => index !== target),
        };
  },
  "change an effect's arguments": (line) => {
    const target = firstEffect(line);

    return target === -1
      ? undefined
      : {
          ...line,
          effects: line.effects.map((effect, index) =>
            index === target ? { ...effect, args: ["__control__"] } : effect,
          ),
        };
  },
  "rename an effect": (line) => {
    const target = firstEffect(line);

    return target === -1
      ? undefined
      : {
          ...line,
          effects: line.effects.map((effect, index) =>
            index === target
              ? { ...effect, fn: `${effect.fn}__control` }
              : effect,
          ),
        };
  },
  // An overlapping call would be set aside as incomplete, and then nothing is left to catch.
  "add a write to module state": (line) => ({
    ...line,
    overlapped: false,
    moduleAfter: { __control__: 1 },
  }),
  "add a write to an argument": (line) => {
    if (!Array.isArray(line.args)) return undefined;
    const target = line.args.findIndex(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        !Array.isArray(arg) &&
        !("$big" in arg) &&
        !("$undefined" in arg),
    );

    return target === -1
      ? undefined
      : {
          ...line,
          argsAfter: line.args.map((arg, index) =>
            index === target
              ? { ...withControlField(arg as Record<string, unknown>) }
              : arg,
          ),
        };
  },
  "add a write to the receiver": (line) =>
    typeof line.self === "object" &&
    line.self !== null &&
    !Array.isArray(line.self)
      ? {
          ...line,
          selfAfter: withControlField(line.self as Record<string, unknown>),
        }
      : undefined,
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
async function main(): Promise<void> {
  const twins = readResults().filter(
    (twin) =>
      twin.traced &&
      // Damage changes effects, so a twin whose compared calls made none has nothing to catch.
      twin.compared > 0 &&
      twin.stateUnmodelled === 0 &&
      twin.internal.length + twin.external.length > 0 &&
      statSync(tracePath(twin.source)).size <= MAX_SAMPLED_TRACE_BYTES,
  );
  const step = Math.max(1, Math.floor(twins.length / SAMPLE));
  const sample = twins.filter((_, index) => index % step === 0);
  let failed = 0;
  let caught = 0;
  const damaged = Object.entries(DAMAGES).flatMap(([name, damage]) =>
    sample.map((twin) => ({ name: name, damage: damage, source: twin.source })),
  );
  const verdicts = await pooled(damaged, JOBS, (item) =>
    damagedVerdict(item.source, item.damage),
  );
  verdicts.forEach((verdict, index) => {
    if (verdict === undefined) return;
    if (verdict) caught += 1;
    else {
      failed += 1;
      console.log(`MISSED ${damaged[index]?.name}: ${damaged[index]?.source}`);
    }
  });
  const plain = readResults().filter(
    (twin) => !twin.traced && twin.compared > 0,
  );
  const plainStep = Math.max(1, Math.floor(plain.length / SAMPLE));
  const plainSample = plain.filter((_, index) => index % plainStep === 0);
  const plainVerdicts = await pooled(plainSample, JOBS, (twin) =>
    damagedPlainVerdict(twin.source),
  );
  plainVerdicts.forEach((verdict, index) => {
    if (verdict) caught += 1;
    else {
      failed += 1;
      console.log(
        `MISSED change a plain result: ${plainSample[index]?.source}`,
      );
    }
  });
  console.log(`${caught} damaged recordings caught`);
  const faultRuns = await pooled(
    FAULTS.flatMap((fault) => [
      { fault: fault, active: false },
      { fault: fault, active: true },
    ]),
    JOBS,
    (run) => runFault(run.fault, run.active),
  );
  for (const [index, fault] of FAULTS.entries()) {
    const clean = faultRuns[2 * index];
    const faulty = faultRuns[2 * index + 1];
    if (
      !clean ||
      !faulty ||
      clean.mismatches > 0 ||
      clean.compared === 0 ||
      faulty.mismatches === 0
    ) {
      failed += 1;
      console.log(
        `FAULT NOT CAUGHT ${fault.name}: clean ${clean?.compared}/${clean?.mismatches}, faulty ${faulty?.compared}/${faulty?.mismatches}`,
      );
    } else {
      caught += 1;
      console.log(`caught ${fault.name}`);
    }
  }
  console.log(`${caught} caught, ${failed} missed`);
  if (failed > 0) process.exit(1);
}

// A class instance keeps its fields under `$fields`, which is where a write would show up.
function withControlField(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const fields = value["$fields"];

  return fields && typeof fields === "object"
    ? { ...value, $fields: { ...fields, __control__: 1 } }
    : { ...value, __control__: 1 };
}

// A callback entry is the outside calling in, so only a real effect is worth damaging.
function firstEffect(line: Line): number {
  return line.effects.findIndex((effect) => !effect.fn.startsWith("$enter:"));
}

function tracePath(source: string): string {
  return join(TRACES, `${encodeURIComponent(source)}.jsonl`);
}

function readResults(): Result[] {
  const parsed = JSON.parse(
    readFileSync(join(OUT, "results.json"), "utf8"),
  ) as { twins: Result[] };

  return parsed.twins;
}

// A plain twin is compared on its return value alone, so that comparison must be able to fail too.
async function damagedPlainVerdict(source: string): Promise<boolean> {
  const encoded = `${encodeURIComponent(source)}.jsonl`;
  const lines = readFileSync(join(OUT, "corpus", encoded), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => ({
      ...(JSON.parse(line) as Record<string, unknown>),
      outcome: { returned: { control: "__control__" } },
    }));
  const directory = mkdtempSync(join(tmpdir(), "spec-twin-control-"));
  writeFileSync(
    join(directory, encoded),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  const result = await conform(source, directory, "corpus");
  rmSync(directory, { recursive: true, force: true });

  return result.mismatches > 0;
}

async function damagedVerdict(
  source: string,
  damage: Damage,
): Promise<boolean | undefined> {
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
  const result = await conform(source, directory);
  rmSync(directory, { recursive: true, force: true });

  return result.mismatches > 0 || result.stateUnmodelled > 0;
}

// Each run writes its own result file, so runs beside each other do not overwrite one another.
async function conform(
  source: string,
  recordings: string,
  kind: "traces" | "corpus" = "traces",
): Promise<Result> {
  const out = `${recordings}.result.json`;
  await launch(
    "bun",
    [
      "formal/scripts/conform.ts",
      "--reuse",
      "--jobs=1",
      `--${kind}=${recordings}`,
      `--only=${source}`,
      `--out=${out}`,
    ],
    { cwd: ROOT },
  );
  const parsed = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as { twins: Result[] })
    : { twins: [] };
  rmSync(out, { force: true });

  return (
    parsed.twins[0] ?? {
      source: source,
      traced: true,
      compared: 0,
      mismatches: 0,
    }
  );
}

async function runFault(
  fault: (typeof FAULTS)[number],
  active: boolean,
): Promise<Result> {
  const directory = mkdtempSync(join(tmpdir(), "spec-twin-fault-"));
  const corpus = join(directory, "corpus");
  const traces = join(directory, "traces");
  mkdirSync(corpus);
  mkdirSync(traces);
  const sources = join(directory, "sources.txt");
  writeFileSync(sources, fault.twin);
  const run = await launch(
    "bun",
    ["test", "--preload", PRELOAD, ...fault.tests],
    {
      cwd: join(ROOT, fault.cwd),
      // A fault can turn a loop infinite, and the recorder would then fill the machine's memory.
      timeout: FAULT_RUN_LIMIT_MS,
      quiet: true,
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
    },
  );
  if (run.status === null) console.log(`  run did not finish: ${fault.name}`);
  const result = await conform(fault.twin, traces);
  rmSync(directory, { recursive: true, force: true });

  return result;
}

await main();
