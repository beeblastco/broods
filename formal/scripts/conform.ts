import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { analyzeFile, listFunctions, ROOT } from "./functions.ts";
import { inputsHash, manifestSources, sourcesHash } from "./inputs.ts";

const FORMAL = join(ROOT, "formal");
const subsystem = option("sub");
const BINARY = join(
  FORMAL,
  ".lake/build/bin",
  subsystem ? `twins-${subsystem}` : "spec-replay",
);
const OUT = join(FORMAL, ".lake/conform");
const CORPUS = option("corpus") ?? join(OUT, "corpus");
const TRACES = option("traces") ?? join(OUT, "traces");
const ONLY = option("only");
const PRELOAD = join(FORMAL, "replay/record-preload.ts");
const BASELINE = join(FORMAL, ".lake/conform-baseline");
const RUN_LIMIT_MS = 1_500_000;
// Each workspace runs its own test command from its own folder, so its bunfig preloads still apply.
const TEST_DIRS = [
  "apps/core",
  "apps/gateway",
  "apps/edge",
  "apps/discord-forwarder",
  "apps/cloudflare-mcp",
  "apps/cloudflare-worker",
  "packages/convex",
  "apps/cloudflare-sandbox",
];

interface TwinRow {
  source: string;
  gaps: string[];
  traced: boolean;
}

// What the recorder writes for any value: plain JSON, with `$`-tagged objects for the rest.
type Encoded =
  | string
  | number
  | boolean
  | null
  | undefined
  | Encoded[]
  | { [key: string]: Encoded };

interface RecordedEffect {
  fn: string;
  to?: string;
  args: unknown;
  outcome: { returned?: unknown; threw?: unknown; pending?: boolean };
  start: number;
  settle: number | null;
  nested: boolean | "detached";
  selfBefore?: unknown;
  selfAfter?: unknown;
  moduleBefore?: unknown;
  moduleAfter?: unknown;
  argWindows?: { index: number; before: Encoded; after: Encoded }[];
}

interface Traced {
  fn: string;
  args: Encoded[];
  self: unknown;
  params: unknown;
  env: unknown;
  module: unknown;
  aborted: unknown;
  selfAfter: unknown;
  moduleAfter: unknown;
  argsAfter?: Encoded[];
  windowsLost?: boolean;
  overlapped?: boolean;
  effects: RecordedEffect[];
  outcome: { returned?: unknown; threw?: unknown; sync?: boolean };
  hits: number[];
}

interface Plain {
  fn: string;
  args: unknown[];
  outcome: { returned?: unknown; threw?: string };
  hits?: number[];
}

interface TwinResult {
  source: string;
  traced: boolean;
  recorded: number;
  compared: number;
  unsupported: number;
  incomplete: number;
  incompleteReasons: string[];
  mismatches: number;
  allowedByGap: number;
  hits: number[];
  impliedElse: number[];
  internal: string[];
  external: string[];
  hollow: boolean;
  stateUnmodelled: number;
  firstMismatch?: { args: unknown; expected: unknown; actual: unknown };
}

// Records real calls under the repository's own tests, then checks each against its Lean twin.
// `--reuse` skips recording, which makes editing a twin fast. A mismatch outside a twin's declared
// gaps fails the command. Writes `.lake/conform/results.json`, bound to a hash of its inputs.
function main(): void {
  const extra = option("record-extra");
  if (extra) {
    recordExtra(extra);

    return;
  }
  const control = Boolean(option("traces") || option("corpus") || ONLY);
  if (!option("traces") && !option("corpus")) buildTwins();
  const twins = readTwins().filter((twin) => !ONLY || twin.source === ONLY);
  console.log(`${twins.length} twins`);
  let brokenRecording = false;
  if (process.argv.includes("--all")) brokenRecording = record(allFunctions());
  else if (!process.argv.includes("--reuse"))
    brokenRecording = record(twins.map((t) => t.source));
  if (!option("traces") && !option("corpus") && !recordingIsCurrent()) {
    console.log(
      "STALE: source or tooling changed since these recordings were captured",
    );
    brokenRecording = true;
  }
  const opaqueAllowed = declaredOpaque();
  const results = twins.map((twin) => {
    const result = twin.traced
      ? checkTraced(twin, opaqueAllowed)
      : checkPlain(twin);

    // A twin with nothing compared says nothing about whether the function gave an answer.
    return { ...result, hollow: result.compared > 0 && result.hollow };
  });
  // Credit is bound to this file's hash, so a recording that cannot be trusted must not write it.
  if (control || !brokenRecording)
    writeFileSync(
      resultsPath(),
      `${JSON.stringify({ inputs: inputsHash(), twins: results }, null, 1)}\n`,
    );
  let failed = 0;
  for (const result of results) {
    const unexpected = result.mismatches - result.allowedByGap;
    if (unexpected > 0) failed += 1;
    if (unexpected > 0 || result.compared === 0) {
      console.log(
        `${unexpected > 0 ? "MISMATCH" : "UNCHECKED"} ${result.source}: ` +
          `${result.recorded} recorded, ${result.compared} compared, ` +
          `${result.unsupported} unsupported, ${result.incomplete} incomplete, ` +
          `${result.mismatches} mismatches`,
      );
    }
    if (unexpected > 0)
      console.log(
        `  first: ${JSON.stringify(result.firstMismatch)}`.slice(0, 1200),
      );
  }
  const compared = results.filter((result) => result.compared > 0).length;
  const calls = results.reduce((total, result) => total + result.compared, 0);
  console.log(
    `${compared} of ${twins.length} twins compared on ${calls} recorded calls, ${failed} failing`,
  );
  if (failed > 0 || brokenRecording) process.exit(1);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;

  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function resultsPath(): string {
  if (option("traces") || option("corpus") || ONLY)
    return join(OUT, "results-control.json");

  return join(OUT, subsystem ? `results-${subsystem}.json` : "results.json");
}

function buildTwins(): void {
  const run = spawnSync(
    "lake",
    ["build", subsystem ? `twins-${subsystem}` : "spec-replay"],
    {
      cwd: FORMAL,
      encoding: "utf8",
    },
  );
  if (run.status !== 0)
    throw new Error(`lake build failed: ${run.stdout}${run.stderr}`);
}

function readTwins(): TwinRow[] {
  const result = spawnSync(BINARY, ["twins"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (result.status !== 0)
    throw new Error(`run lake build in formal/ first: ${result.stderr}`);

  // A later pass may rewrite a plain twin as a traced one; `twin-run` then prefers the traced one.
  const rows = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TwinRow);

  return rows.filter(
    (row) =>
      row.traced ||
      !rows.some((other) => other.traced && other.source === row.source),
  );
}

function recordingIsCurrent(): boolean {
  const path = join(OUT, "captured.json");
  if (!existsSync(path)) return false;
  const captured = JSON.parse(readFileSync(path, "utf8")) as {
    sources: string;
  };

  return captured.sources === sourcesHash();
}

function allFunctions(): string[] {
  return manifestSources()
    .filter((path) => /\.(ts|mjs)$/.test(path) && !path.endsWith(".d.ts"))
    .flatMap((path) => listFunctions(path).map((entry) => entry.source));
}

function declaredOpaque(): Set<string> {
  const directory = join(FORMAL, "boundaries.d");
  const extra = existsSync(directory)
    ? readdirSync(directory).map((file) => join(directory, file))
    : [];

  return new Set(
    [join(FORMAL, "boundaries.tsv"), ...extra]
      .filter((path) => existsSync(path))
      .flatMap((path) => readFileSync(path, "utf8").split("\n"))
      .filter((line) => line.startsWith("opaque\t"))
      .map((line) => line.split("\t")[1] ?? ""),
  );
}

// Returns true when instrumentation changed a test's result or a run did not finish, either of
// which makes the recording untrustworthy.
function record(wanted: string[]): boolean {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(CORPUS, { recursive: true });
  mkdirSync(TRACES, { recursive: true });
  mkdirSync(BASELINE, { recursive: true });
  const sources = join(OUT, "sources.txt");
  writeFileSync(sources, wanted.join("\n"));
  let broken = false;
  for (const directory of TEST_DIRS) {
    if (!existsSync(join(ROOT, directory))) continue;
    const before = baselineFailures(directory);
    const name = directory.replaceAll("/", "-");
    const coverage = join(OUT, "coverage", name);
    const report = join(OUT, `${name}.junit.xml`);
    const run = spawnSync(
      "bun",
      [
        "test",
        "--isolate",
        "--max-concurrency=1",
        "--timeout=60000",
        "--preload",
        PRELOAD,
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${coverage}`,
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        ...extraTests(directory),
      ],
      {
        cwd: join(ROOT, directory),
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: RUN_LIMIT_MS,
        env: {
          ...process.env,
          SPEC_CORPUS: CORPUS,
          SPEC_TRACES: TRACES,
          SPEC_RECORD_SOURCES: sources,
        },
      },
    );
    const after = failingTests(report);
    const introduced = stillFailing(
      directory,
      [...after].filter((test) => !before.has(test)),
      sources,
    );
    console.log(
      `${directory}: ${after.size} failing, baseline ${before.size}, ${introduced.length} introduced by recording`,
    );
    for (const test of introduced.slice(0, 40))
      console.log(`  INTRODUCED ${test}`);
    const ran = testCount(report);
    const expected = testCount(join(BASELINE, `${name}.junit.xml`));
    if (ran < 0.99 * expected) {
      console.log(`  ONLY ${ran} OF ${expected} TESTS RAN`);
      broken = true;
    }
    if (run.status === null || !existsSync(report)) {
      console.log(`  RUN DID NOT FINISH: ${run.signal ?? run.error?.message}`);
      broken = true;
    }
    if (introduced.length > 0) broken = true;
  }
  // Only a sound recording counts as captured, so `--reuse` cannot credit a broken one later.
  if (!broken)
    writeFileSync(
      join(OUT, "captured.json"),
      `${JSON.stringify({ sources: sourcesHash() })}\n`,
    );

  return broken;
}

// Tests written for the specification, in `replay/extra/<workspace>/`. Bun runs these with the
// workspace's own tests when both are named, so the workspace's tests are named too.
function extraTests(directory: string): string[] {
  const folder = join(
    FORMAL,
    "replay/extra",
    directory.split("/").at(-1) ?? "",
  );
  if (!existsSync(folder)) return [];

  return [join(ROOT, directory), folder];
}

// Runs one specification test and adds what it recorded to the shared recordings.
function recordExtra(path: string): void {
  const directory = TEST_DIRS.find((item) =>
    path.includes(`replay/extra/${item.split("/").at(-1) ?? ""}/`),
  );
  if (!directory) throw new Error(`no workspace for ${path}`);
  // Only a passing run reaches the shared recordings, so a failed draft costs nothing.
  const scratch = mkdtempSync(join(OUT, "extra-"));
  const corpus = join(scratch, "corpus");
  const traces = join(scratch, "traces");
  const run = spawnSync(
    "bun",
    ["test", "--preload", PRELOAD, join(ROOT, path)],
    {
      cwd: join(ROOT, directory),
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: RUN_LIMIT_MS,
      env: {
        ...process.env,
        SPEC_CORPUS: corpus,
        SPEC_TRACES: traces,
        SPEC_RECORD_SOURCES: join(OUT, "sources.txt"),
      },
    },
  );
  console.log(`${run.stdout}${run.stderr}`.split("\n").slice(-12).join("\n"));
  if (run.status === 0) {
    mergeRecordings(corpus, CORPUS);
    mergeRecordings(traces, TRACES);
  }
  rmSync(scratch, { recursive: true, force: true });
  if (run.status !== 0) process.exit(1);
}

function mergeRecordings(from: string, to: string): void {
  if (!existsSync(from)) return;
  for (const file of readdirSync(from))
    appendFileSync(join(to, file), readFileSync(join(from, file)));
}

function baselineFailures(directory: string): Set<string> {
  const name = directory.replaceAll("/", "-");
  const report = join(BASELINE, `${name}.junit.xml`);
  if (!existsSync(report)) {
    spawnSync(
      "bun",
      [
        "test",
        "--isolate",
        "--max-concurrency=1",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        ...extraTests(directory),
      ],
      {
        cwd: join(ROOT, directory),
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: RUN_LIMIT_MS,
      },
    );
  }

  return existsSync(report) ? failingTests(report) : new Set();
}

function testCount(report: string): number {
  if (!existsSync(report)) return 0;

  return [...readFileSync(report, "utf8").matchAll(/<testcase\b/g)].length;
}

// Coverage slows tests that assert on elapsed time. A test that passes once more under the
// recorder, without coverage, was not changed by recording.
function stillFailing(
  directory: string,
  tests: string[],
  sources: string,
): string[] {
  if (tests.length === 0) return [];
  const report = join(OUT, `${directory.replaceAll("/", "-")}.retry.xml`);
  spawnSync(
    "bun",
    [
      "test",
      "--isolate",
      "--max-concurrency=1",
      "--timeout=60000",
      "--preload",
      PRELOAD,
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...new Set(tests.map((test) => test.split(" ")[0] ?? "")),
    ],
    {
      cwd: join(ROOT, directory),
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: RUN_LIMIT_MS,
      env: {
        ...process.env,
        SPEC_CORPUS: CORPUS,
        SPEC_TRACES: TRACES,
        SPEC_RECORD_SOURCES: sources,
      },
    },
  );
  if (!existsSync(report)) return tests;
  const again = failingTests(report);

  return tests.filter((test) => again.has(test));
}

function failingTests(report: string): Set<string> {
  if (!existsSync(report)) return new Set();
  const failing = new Set<string>();
  const text = readFileSync(report, "utf8");
  for (const match of text.matchAll(/<testcase\b([^>]*?)>\s*<failure\b/g)) {
    const attributes = match[1] ?? "";
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const classname = /\bclassname="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const file = /\bfile="([^"]*)"/.exec(attributes)?.[1] ?? "";
    failing.add(`${file} ${classname} ${name}`);
  }

  return failing;
}

function checkPlain(twin: TwinRow): TwinResult {
  const result = emptyResult(twin);
  const path = join(CORPUS, `${encodeURIComponent(twin.source)}.jsonl`);
  if (!existsSync(path)) return result;
  const calls = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Plain);
  result.recorded = calls.length;
  // A plain twin only returns a value, so it can state no change the call made.
  result.stateUnmodelled = readTraced(twin.source).filter(
    (call) => stateChanges(call).length > 0,
  ).length;
  if (result.stateUnmodelled > 0) result.hollow = false;
  const input = calls
    .map((call) => JSON.stringify({ fn: call.fn, args: call.args }))
    .join("\n");
  const outputs = runTwin(input);
  const hits = new Set<number>();
  const sets: number[][] = [];
  calls.forEach((call, index) => {
    const actual = JSON.parse(
      outputs[index] ?? '{"unsupported":"no output"}',
    ) as Record<string, unknown> | null;
    if (typeof actual?.["unsupported"] === "string") {
      result.unsupported += 1;

      return;
    }
    result.compared += 1;
    const expected =
      call.outcome.threw === undefined
        ? call.outcome.returned
        : { threw: call.outcome.threw };
    const covered = actual?.["gapCovered"] === true;
    if (
      canonical(expected) !== canonical(covered ? actual?.["output"] : actual)
    ) {
      noteMismatch(result, twin, call.args, expected, actual, covered);

      return;
    }
    for (const offset of call.hits ?? []) hits.add(offset);
    sets.push(call.hits ?? []);
    if (expected !== null && expected !== undefined) result.hollow = false;
  });
  result.hits = [...hits];
  result.impliedElse = impliedElse(twin.source, sets);

  return result;
}

// A traced twin is handed each recorded effect only after asking for it correctly. It must end the
// same way and leave none over. A call whose recording lost information is not compared at all.
function readTraced(source: string): Traced[] {
  const path = join(TRACES, `${encodeURIComponent(source)}.jsonl`);
  if (!existsSync(path)) return [];

  return [
    ...new Set(readFileSync(path, "utf8").split("\n").filter(Boolean)),
  ].map((line) => JSON.parse(line) as Traced);
}

function checkTraced(twin: TwinRow, opaqueAllowed: Set<string>): TwinResult {
  const result = emptyResult(twin);
  const all = readTraced(twin.source);
  result.recorded = all.length;
  const reasons = new Set<string>();
  const calls = all.filter((call) => {
    const problems = incompleteReasons(call, opaqueAllowed);
    for (const problem of problems) reasons.add(problem);
    if (problems.length > 0) result.incomplete += 1;

    return problems.length === 0;
  });
  result.incompleteReasons = [...reasons].sort();
  const input = calls
    .map((call) =>
      JSON.stringify({
        fn: call.fn,
        args: call.args,
        self: call.self,
        params: call.params,
        env: call.env,
        module: call.module,
        aborted: call.aborted,
        state: stateChanges(call),
        effects: withBlocks(call.effects).map((effect) => ({
          fn: effect.fn,
          args: effect.args,
          outcome: effect.outcome,
          block: effect.block,
          blockSize: effect.blockSize,
        })),
      }),
    )
    .join("\n");
  const outputs = calls.length > 0 ? runTwin(input) : [];
  const hits = new Set<number>();
  const sets: number[][] = [];
  const internal = new Set<string>();
  const bare = new Set<string>();
  calls.forEach((call, index) => {
    const actual = JSON.parse(
      outputs[index] ?? '{"unsupported":"no output"}',
    ) as Record<string, unknown>;
    if (typeof actual["unsupported"] === "string") {
      result.unsupported += 1;

      return;
    }
    result.compared += 1;
    const outcome =
      "threw" in call.outcome
        ? { threw: call.outcome.threw }
        : { returned: call.outcome.returned };
    if (
      "diverged" in actual ||
      canonical(outcome) !== canonical(actual["outcome"])
    ) {
      noteMismatch(
        result,
        twin,
        call.args,
        { outcome: outcome },
        actual,
        false,
      );

      return;
    }
    for (const offset of call.hits) hits.add(offset);
    sets.push(call.hits);
    const checked = new Set(
      (actual["stateChecked"] as string[] | undefined) ?? [],
    );
    if (stateChanges(call).some((change) => !checked.has(change.path)))
      result.stateUnmodelled += 1;
    if (
      call.effects.length > 0 ||
      !isUndefined(outcome) ||
      stateChanges(call).length > 0
    )
      result.hollow = false;
    for (const effect of call.effects) {
      if (effect.to) internal.add(effect.to);
      else bare.add(effect.fn);
    }
  });
  // A test may mock our own callee. Where the same call site reached the real one in another
  // recording, the mocked answer stands for that callee, which must then earn credit itself.
  const reached = new Map<string, Set<string>>();
  for (const effect of calls.flatMap((call) => call.effects)) {
    if (effect.to)
      reached.set(
        effect.fn,
        (reached.get(effect.fn) ?? new Set()).add(effect.to),
      );
  }
  const external = new Set<string>();
  for (const label of bare) {
    const targets = reached.get(label);
    if (targets) for (const target of targets) internal.add(target);
    else external.add(label);
  }
  result.hits = [...hits];
  result.impliedElse = impliedElse(twin.source, sets);
  result.internal = [...internal].sort();
  result.external = [...external].sort();

  return result;
}

// A call that returned nothing and did nothing visible gives a twin nothing to be right about.
function isUndefined(outcome: { returned?: unknown }): boolean {
  const returned = outcome.returned as { $undefined?: boolean } | undefined;

  return "returned" in outcome && returned?.$undefined === true;
}

// What the call changed on its receiver or in module state, field by field. Timing-independent
// data only: a value the recorder could not carry stays in the list, and a twin cannot state it.
function stateChanges(call: Traced): { path: string; value: unknown }[] {
  const changes: { path: string; value: unknown }[] = [];
  const compare = (prefix: string, before: unknown, after: unknown): void => {
    const was = fieldsOf(before);
    const now = fieldsOf(after);
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (
        key === "$keys" ||
        sameBesideHanded(was[key] as Encoded, now[key] as Encoded)
      )
        continue;
      changes.push({ path: `${prefix}.${key}`, value: now[key] ?? null });
    }
  };
  compare("self", call.self, call.selfAfter);
  call.argsAfter?.forEach((after, index) => {
    deepChanges(`args.${index}`, call.args[index], after, changes);
  });
  compare("module", call.module, call.moduleAfter);
  // A traced callee answers for a leaf only if the call ended with the value that callee left.
  const byCallee = new Map<string, unknown>();
  const noteCallee = (
    prefix: string,
    before: Encoded,
    after: Encoded,
  ): void => {
    const during: { path: string; value: unknown }[] = [];
    deepChanges(prefix, before, after, during);
    for (const change of during) byCallee.set(change.path, change.value);
  };
  for (const effect of call.effects) {
    for (const window of effect.argWindows ?? [])
      if (!hasBig(window.before) && !hasBig(window.after))
        noteCallee(`args.${window.index}`, window.before, window.after);
    if (
      effect.to &&
      effect.moduleBefore !== undefined &&
      !hasBig(effect.moduleBefore) &&
      !hasBig(effect.moduleAfter)
    ) {
      const was = fieldsOf(effect.moduleBefore);
      const now = fieldsOf(effect.moduleAfter);
      for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (
          key !== "$keys" &&
          !sameBesideHanded(was[key] as Encoded, now[key] as Encoded)
        )
          byCallee.set(`module.${key}`, now[key] ?? null);
      }
    }
    if (
      effect.to &&
      effect.selfBefore !== undefined &&
      !hasBig(effect.selfBefore) &&
      !hasBig(effect.selfAfter)
    ) {
      const was = fieldsOf(effect.selfBefore);
      const now = fieldsOf(effect.selfAfter);
      for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (
          key !== "$keys" &&
          !sameBesideHanded(was[key] as Encoded, now[key] as Encoded)
        )
          byCallee.set(`self.${key}`, now[key] ?? null);
      }
    }
  }

  return changes.filter(
    (change) =>
      !byCallee.has(change.path) ||
      hasBig(change.value) ||
      !sameBesideHanded(
        change.value as Encoded,
        byCallee.get(change.path) as Encoded,
      ),
  );
}

// `$big` is one marker for every value too large to record, so it proves nothing about who wrote.
function hasBig(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('"$big"');
}

// Every leaf that differs, so two writes to one object are told apart. An array counts as one leaf.
function deepChanges(
  path: string,
  before: Encoded,
  after: Encoded,
  out: { path: string; value: unknown }[],
): void {
  if (sameBesideHanded(before, after)) return;
  if (
    typeof before !== "object" ||
    before === null ||
    Array.isArray(before) ||
    typeof after !== "object" ||
    after === null ||
    Array.isArray(after)
  ) {
    out.push({ path: path, value: after ?? null });

    return;
  }
  const was = fieldsOf(before) as Record<string, Encoded>;
  const now = fieldsOf(after) as Record<string, Encoded>;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key !== "$keys" && key !== "$class")
      deepChanges(`${path}.${key}`, was[key], now[key], out);
  }
}

// Equal, leaving out whatever an effect was handed, since that effect answers for it.
function sameBesideHanded(before: Encoded, after: Encoded): boolean {
  if (typeof after !== "object" || after === null)
    return canonical(before) === canonical(after);
  if (Array.isArray(after))
    return (
      Array.isArray(before) &&
      before.length === after.length &&
      before.every((item, index) => sameBesideHanded(item, after[index]))
    );
  if (after["$handed"] === true) return true;
  if (typeof before !== "object" || before === null || Array.isArray(before))
    return false;

  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => key !== "$keys" && key !== "$class")
    .every((key) => sameBesideHanded(before[key], after[key]));
}

function fieldsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const fields = record["$fields"];

  return (fields && typeof fields === "object" ? fields : record) as Record<
    string,
    unknown
  >;
}

function emptyResult(twin: TwinRow): TwinResult {
  return {
    source: twin.source,
    traced: twin.traced,
    recorded: 0,
    compared: 0,
    unsupported: 0,
    incomplete: 0,
    incompleteReasons: [],
    mismatches: 0,
    allowedByGap: 0,
    hits: [],
    impliedElse: [],
    internal: [],
    external: [],
    hollow: true,
    stateUnmodelled: 0,
  };
}

function noteMismatch(
  result: TwinResult,
  twin: TwinRow,
  args: unknown,
  expected: unknown,
  actual: unknown,
  covered: boolean,
): void {
  result.mismatches += 1;
  if (covered && twin.gaps.length > 0) result.allowedByGap += 1;
  result.firstMismatch ??= {
    args: args,
    expected: expected,
    actual: actual,
  };
}

function runTwin(input: string): string[] {
  const run = spawnSync(BINARY, ["twin-run"], {
    input: `${input}\n`,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

  return run.stdout.split("\n").filter(Boolean);
}

// Reasons a recording cannot be compared: a value was too big or
// of a class no entry in `boundaries.tsv` says can be erased.
function incompleteReasons(call: Traced, opaqueAllowed: Set<string>): string[] {
  const problems = new Set<string>();
  if (call.overlapped && canonical(call.module) !== canonical(call.moduleAfter))
    problems.add(
      "module state changed while another call of this function ran",
    );
  if (call.windowsLost)
    problems.add("too many effects touched an argument to separate them");
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if ("$big" in record) problems.add("too big to record");
      if (
        typeof record["$opaque"] === "string" &&
        !opaqueAllowed.has(record["$opaque"])
      ) {
        problems.add(`opaque ${record["$opaque"]}`);
      }
      // `$fields` is left out of results; a write hidden by its truncation is covered by L18.
      for (const [key, item] of Object.entries(record)) {
        if (key !== "$fields") scan(item);
      }
    }
  };
  scan(call.args);
  scan(call.self);
  scan(call.params);
  scan(call.env);
  scan(call.module);
  scan(call.outcome);
  scan(call.argsAfter);
  for (const effect of call.effects) {
    scan(effect.args);
    scan(effect.outcome);
  }

  return [...problems];
}

// A callback runs inside the effect that called it, so a twin handles the callback before it is
// handed that effect's answer. Otherwise it could read an answer the callback helped to produce.
function callbacksFirst(effects: RecordedEffect[]): RecordedEffect[] {
  const out: RecordedEffect[] = [];
  const placed = new Set<RecordedEffect>();
  effects.forEach((effect, index) => {
    if (placed.has(effect)) return;
    if (!effect.nested && effect.settle !== null) {
      for (const later of effects.slice(index + 1)) {
        if (
          later.nested === true &&
          !placed.has(later) &&
          later.start < effect.settle
        ) {
          out.push(later);
          placed.add(later);
        }
      }
    }
    out.push(effect);
    placed.add(effect);
  });

  return out;
}

// Effects made directly by the function that overlapped in time form one group, which a twin must
// start together with `par`. A callback's effects happen inside something else's run, so they
// overlap that run by construction and only their order counts.
function withBlocks(
  recorded: RecordedEffect[],
): (RecordedEffect & { block: number; blockSize: number })[] {
  const effects = callbacksFirst(recorded);
  const blocks: number[] = [];
  let block = -1;
  let end = -1;
  for (const effect of effects) {
    if (effect.nested) {
      block += 1;
      blocks.push(block);
      end = -1;
      continue;
    }
    if (effect.start >= end) block += 1;
    blocks.push(block);
    // An effect the function never waited for overlaps nothing it waited on.
    end = Math.max(end, effect.settle ?? effect.start + 1);
  }

  return effects.map((effect, index) => ({
    ...effect,
    block: blocks[index] ?? 0,
    blockSize: blocks.filter((item) => item === blocks[index]).length,
  }));
}

// An `if` with no `else` has no statement for its false path, so that path is known to have run
// when the `if` ran and its consequent did not, in one call.
function impliedElse(source: string, sets: number[][]): number[] {
  const file = source.split("#")[0] ?? "";
  if (!existsSync(join(ROOT, file))) return [];
  const arms = analyzeFile(file, readFileSync(join(ROOT, file), "utf8")).arms;
  const credited = new Set<number>();
  for (const arm of arms) {
    if (!arm.implicit || arm.owner !== source) continue;
    for (const set of sets) {
      if (
        set.includes(arm.node.start) &&
        arm.consequent !== undefined &&
        !set.includes(arm.consequent)
      ) {
        credited.add(arm.node.start);
      }
    }
  }

  return [...credited];
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;

      return Object.fromEntries(
        Object.keys(record)
          .filter(
            (key) => key !== "$fields" && key !== "$keys" && key !== "$class",
          )
          .sort()
          .map((key) => [key, record[key]]),
      );
    }

    return item;
  });
}

main();
