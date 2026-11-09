import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { SUITES } from "../replay/suites/index.ts";
import type { Suite } from "../replay/suite.ts";
import { functionNode, unobservedCalls } from "../replay/instrument.ts";
import { analyzeFile, type AstNode, type FileAnalysis } from "./functions.ts";
import { inputsHash, sourcesHash } from "./inputs.ts";

const FORMAL = resolve(import.meta.dir, "..");
const TRACES = join(FORMAL, ".lake/conform/traces");
const PURE_PLAIN_EFFECT = /^new \w*Error$|\.safeParse$/;
const ROOT = resolve(FORMAL, "..");
const LAKE = join(process.env.HOME ?? "", ".elan/bin/lake");
const RUNTIME_DIRS = [
  "apps/core/src",
  "apps/gateway/src",
  "apps/edge/src",
  "apps/discord-forwarder/src",
  "apps/cloudflare-mcp",
  "apps/cloudflare-sandbox",
  "apps/cloudflare-worker",
  "apps/lambda",
];
const FORBIDDEN =
  /\b(sorry|axiom|native_decide|partial|unsafe|implemented_by|extern|opaque)\b/;
const STATUSES = new Set([
  "replayed",
  "modelled",
  "contract",
  "excluded",
  "open",
]);
const CLASSES = new Set(["decision", "protocol", "adapter", "glue"]);
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;"']*?from\s+"([^"]+)"|require\("([^"]+)"\)/g;

interface Row {
  subsystem: string;
  path: string;
  fileClass: string;
  status: string;
  loc: number;
  note: string;
}

interface LineCounts {
  found: number;
  hit: Set<number>;
}

// Runs every check over `formal/` and prints the coverage table. `--update-statements` accepts the
// kernel's current statements as the new pinned text, which a reviewer then reads in the diff.
function main(): void {
  const args = new Set(process.argv.slice(2));
  const failures: string[] = [];
  failures.push(...checkText());
  if (!args.has("--skip-lean"))
    failures.push(...checkLean(args.has("--update-statements")));
  const rows = readManifest(failures);
  checkScope(rows, failures);
  checkInstrumentation(failures);
  checkContract(failures);
  const coverage = args.has("--skip-replay") ? new Map() : runReplay(failures);
  if (!args.has("--skip-controls")) {
    const controls = spawnSync("bun", ["formal/scripts/controls.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
    console.log(controls.stdout.split("\n").at(-2) ?? "");
    if (controls.status !== 0)
      failures.push(`controls failed:\n${controls.stdout}${controls.stderr}`);
  }
  report(rows, coverage, failures);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log("ALL CHECKS PASSED");
}

function checkInstrumentation(failures: string[]): void {
  const run = spawnSync("bun", ["test", "formal/replay/instrument.test.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (run.status !== 0)
    failures.push(
      `instrumentation changed behaviour:\n${run.stdout}${run.stderr}`,
    );
}

function checkText(): string[] {
  const failures: string[] = [];
  for (const path of walk(join(FORMAL, "Spec"), ".lean")) {
    const text = stripLeanComments(readFileSync(path, "utf8"));
    const match = FORBIDDEN.exec(text);
    if (match)
      failures.push(
        `${relative(ROOT, path)} uses forbidden word "${match[0]}"`,
      );
  }

  return failures;
}

function checkLean(update: boolean): string[] {
  const build = spawnSync(LAKE, ["build"], {
    cwd: FORMAL,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (build.status !== 0)
    return [`lake build failed:\n${build.stdout}${build.stderr}`];
  const audit = spawnSync(LAKE, ["env", "lean", "Audit.lean"], {
    cwd: FORMAL,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const output = `${audit.stdout}${audit.stderr}`;
  if (audit.status !== 0 || !output.includes("AUDIT PASSED"))
    return [`audit failed:\n${output}`];
  console.log(/AUDIT PASSED[^\n]*/.exec(output)?.[0] ?? "");
  const statements = output.slice(output.indexOf("\nSpec.") + 1);
  const pinned = join(FORMAL, "STATEMENTS.txt");
  if (update || !existsSync(pinned)) {
    writeFileSync(pinned, statements);

    return [];
  }

  return readFileSync(pinned, "utf8") === statements
    ? []
    : [
        "a front statement changed: review it, then rerun with --update-statements",
      ];
}

function readManifest(failures: string[]): Row[] {
  const rows: Row[] = [];
  for (const file of readdirSync(join(FORMAL, "manifest"))) {
    if (!file.endsWith(".tsv")) continue;
    const subsystem = file.replace(".tsv", "");
    const lines = readFileSync(join(FORMAL, "manifest", file), "utf8")
      .trim()
      .split("\n");
    for (const line of lines.slice(1)) {
      const [path = "", fileClass = "", status = "", , , note = ""] =
        line.split("\t");
      if (!existsSync(join(ROOT, path))) {
        failures.push(`manifest ${file}: ${path} does not exist`);
        continue;
      }
      if (!CLASSES.has(fileClass))
        failures.push(`manifest ${file}: ${path} has class "${fileClass}"`);
      if (!STATUSES.has(status))
        failures.push(`manifest ${file}: ${path} has status "${status}"`);
      if (status !== "replayed" && status !== "open" && !note) {
        failures.push(`manifest ${file}: ${path} is ${status} with no reason`);
      }
      const loc = readFileSync(join(ROOT, path), "utf8").split("\n").length - 1;
      rows.push({
        subsystem: subsystem,
        path: path,
        fileClass: fileClass,
        status: status,
        loc: loc,
        note: note,
      });
    }
  }

  return rows;
}

function checkScope(rows: Row[], failures: string[]): void {
  const listed = new Map<string, number>();
  for (const row of rows) listed.set(row.path, (listed.get(row.path) ?? 0) + 1);
  for (const [path, count] of listed) {
    if (count > 1) failures.push(`${path} is in the manifest ${count} times`);
  }
  for (const path of scopeFiles()) {
    if (!listed.has(path))
      failures.push(`${path} is in scope but has no manifest row`);
  }
}

function scopeFiles(): Set<string> {
  const result = spawnSync("git", ["ls-files", ...RUNTIME_DIRS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", ...RUNTIME_DIRS],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  const runtime = `${result.stdout}${untracked.stdout}`
    .split("\n")
    .filter((path) => /\.(ts|mjs)$/.test(path))
    .filter(
      (path) => !/_generated|\.d\.ts$|\.test\.|\/tests?\/|sst-env/.test(path),
    );
  const scope = new Set(runtime);
  const stack = [...runtime];
  while (stack.length > 0) {
    const current = stack.pop() ?? "";
    for (const next of convexImports(current)) {
      if (scope.has(next)) continue;
      scope.add(next);
      stack.push(next);
    }
  }

  return scope;
}

function convexImports(path: string): string[] {
  const found: string[] = [];
  const text = readFileSync(join(ROOT, path), "utf8");
  for (const match of text.matchAll(IMPORT)) {
    if (match[1]) continue;
    const specifier = match[2] ?? match[3] ?? "";
    let base: string | undefined;
    if (specifier.startsWith("@broods/convex/")) {
      base = join("packages/convex", specifier.replace("@broods/convex/", ""));
    } else if (specifier.startsWith(".")) {
      base = relative(ROOT, resolve(ROOT, dirname(path), specifier));
    }
    if (!base?.startsWith("packages/convex/") || base.includes("_generated"))
      continue;
    for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
      const absolute = join(ROOT, candidate);
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        found.push(candidate);
        break;
      }
    }
  }

  return found;
}

function runReplay(failures: string[]): Map<string, LineCounts> {
  const merged = new Map<string, LineCounts>();
  for (const suite of SUITES) {
    if (suite.tests.length === 0) continue;
    const directory = mkdtempSync(join(tmpdir(), "spec-coverage-"));
    const run = runSuite(suite, directory);
    console.log(
      `replay ${suite.name}: ${run.passed} passed, ${run.failed} failed`,
    );
    if (run.failed > 0 || run.passed === 0)
      failures.push(`replay ${suite.name} failed:\n${run.output}`);
    const lcov = join(directory, "lcov.info");
    if (run.failed === 0 && existsSync(lcov))
      mergeLcov(merged, readFileSync(lcov, "utf8"));
    rmSync(directory, { recursive: true, force: true });
  }

  return merged;
}

function runSuite(
  suite: Suite,
  directory: string,
): { passed: number; failed: number; output: string } {
  const result = spawnSync(
    "bun",
    [
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${directory}`,
      ...suite.tests,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      env: { ...process.env, ...suite.env },
    },
  );
  const output = `${result.stdout}${result.stderr}`;

  return {
    passed: Number(/(\d+) pass\b/.exec(output)?.[1] ?? 0),
    failed: Number(/(\d+) fail\b/.exec(output)?.[1] ?? 0),
    output: output,
  };
}

function mergeLcov(merged: Map<string, LineCounts>, lcov: string): void {
  let current: LineCounts | undefined;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const path = relative(ROOT, resolve(ROOT, line.slice(3)));
      current = merged.get(path) ?? { found: 0, hit: new Set<number>() };
      merged.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNumber = "0", count = "0"] = line.slice(3).split(",");
      if (Number(count) > 0) current.hit.add(Number(lineNumber));
    } else if (line.startsWith("LF:") && current) {
      current.found = Math.max(current.found, Number(line.slice(3)));
    }
  }
}

interface TwinResult {
  source: string;
  traced: boolean;
  recorded: number;
  compared: number;
  unsupported: number;
  incomplete: number;
  mismatches: number;
  allowedByGap: number;
  hits: number[];
  impliedElse: number[];
  internal: string[];
  external: string[];
  hollow: boolean;
  stateUnmodelled: number;
}

interface Boundaries {
  external: RegExp[];
  internal: Set<string>;
}

interface Exclusion {
  pattern: string;
  category: string;
}

interface Tally {
  statements: number;
  excluded: number;
  verifiable: number;
  verified: number;
  byTwin: number;
  byReplay: number;
  arms: number;
  armsVerified: number;
}

// Which twins count, and for which statements. A twin must match every call it was compared on and
// cover at least 90% of what was recorded, on a recording that kept what it saw. A traced twin may
// only take answers from boundaries declared in `boundaries.tsv`, or from functions that themselves
// earned credit, so nothing is believed because a caller said so.
function creditedTwins(
  rows: Row[],
  failures: string[],
): Map<string, TwinResult> {
  const path = join(FORMAL, ".lake/conform/results.json");
  const captured = join(FORMAL, ".lake/conform/captured.json");
  if (
    !existsSync(path) ||
    !existsSync(captured) ||
    !existsSync(join(FORMAL, ".lake/conform/traces/_counts.txt"))
  ) {
    failures.push("no twin results: run formal/scripts/conform.ts --all");

    return new Map();
  }
  const { sources } = JSON.parse(readFileSync(captured, "utf8")) as {
    sources: string;
  };
  if (sources !== sourcesHash()) {
    failures.push(
      "recordings were captured against other source or tooling: run formal/scripts/conform.ts --all",
    );

    return new Map();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    inputs: string;
    twins: TwinResult[];
  };
  if (parsed.inputs !== inputsHash()) {
    failures.push(
      "twin results are stale: source, Lean or tooling changed, rerun formal/scripts/conform.ts",
    );

    return new Map();
  }
  for (const twin of parsed.twins) {
    if (twin.mismatches > twin.allowedByGap)
      failures.push(`twin mismatches its recording: ${twin.source}`);
  }
  const boundaries = readBoundaries();
  const counts = readCounts();
  const unobserved = unobservedByFunction(rows);
  const eligible = new Map<string, TwinResult>();
  for (const result of parsed.twins) {
    const seen = counts.get(result.source) ?? {};
    // A trace carries any value, so only a plain twin loses calls whose result is not JSON.
    const lost = result.traced
      ? (seen["traceTooBig"] ?? 0)
      : (seen["tooBig"] ?? 0) + (seen["resultNotJson"] ?? 0);
    if (
      result.compared === 0 ||
      result.hollow ||
      result.stateUnmodelled > 0 ||
      result.mismatches > 0 ||
      result.compared < 0.9 * comparable(result) ||
      result.compared < 0.5 * result.recorded ||
      lost > 0.1 * (seen["attempted"] ?? 0)
    ) {
      continue;
    }
    if (!result.traced && hasImpureEffect(result.source)) continue;
    if (result.traced) {
      if ((unobserved.get(result.source) ?? []).length > 0) continue;
      // A callback entry is the outside calling in, not an answer the function asked for.
      const undeclared = result.external.filter(
        (label) =>
          !label.startsWith("$enter:") &&
          !boundaries.external.some((rule) => rule.test(label)),
      );
      if (undeclared.length > 0) continue;
    }
    eligible.set(result.source, result);
  }
  const hollow = new Set(
    parsed.twins.filter((twin) => twin.hollow).map((twin) => twin.source),
  );
  // Greatest fixed point, so functions that call each other can stand together.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [source, result] of eligible) {
      // A callee that only ever returned undefined with no effects gave no answer to depend on.
      const missing = result.internal.filter(
        (callee) =>
          !eligible.has(callee) &&
          !boundaries.internal.has(callee) &&
          !hollow.has(callee),
      );
      if (missing.length > 0) {
        eligible.delete(source);
        changed = true;
      }
    }
  }

  return eligible;
}

// A value too big to record is the recorder's limit, not a case the twin chose to skip. Such a call
// earns nothing either way, because only compared calls contribute statements.
function comparable(result: TwinResult): number {
  const onlyTooBig =
    result.incompleteReasons.length === 1 &&
    result.incompleteReasons[0] === "too big to record";

  return onlyTooBig ? result.recorded - result.incomplete : result.recorded;
}

// A plain twin only compares a return value, so it cannot vouch for a function that does more
// than build an error or parse a value on the way there.
function hasImpureEffect(source: string): boolean {
  const path = join(TRACES, `${encodeURIComponent(source)}.jsonl`);
  if (!existsSync(path)) return false;

  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) =>
      (
        JSON.parse(line) as { effects: { fn: string; to?: string }[] }
      ).effects.some(
        (effect) =>
          !effect.to &&
          !effect.fn.startsWith("$enter:") &&
          !PURE_PLAIN_EFFECT.test(effect.fn),
      ),
    );
}

// An external rule is a whole-label match, so one rule cannot quietly cover unrelated calls.
function checkContract(failures: string[]): void {
  for (const line of boundaryLines().filter(Boolean)) {
    const [kind = "", name = "", reason = ""] = line.split("\t");
    if (
      !["external", "internal", "opaque"].includes(kind) ||
      !name ||
      !reason
    ) {
      failures.push(`boundary row is malformed: ${line.slice(0, 120)}`);
    } else if (
      kind === "external" &&
      !(name.startsWith("^") && name.endsWith("$"))
    ) {
      failures.push(`external boundary must be anchored: ${name}`);
    } else if (kind === "opaque" && ["", "object", "accessor"].includes(name)) {
      failures.push(`opaque boundary is too broad: ${name}`);
    }
  }
}

function boundaryLines(): string[] {
  const directory = join(FORMAL, "boundaries.d");
  const extra = existsSync(directory)
    ? readdirSync(directory).map((file) => join(directory, file))
    : [];

  return [join(FORMAL, "boundaries.tsv"), ...extra]
    .filter((path) => existsSync(path))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").slice(1));
}

function readBoundaries(): Boundaries {
  const boundaries: Boundaries = { external: [], internal: new Set() };
  for (const line of boundaryLines()) {
    const [kind = "", name = ""] = line.split("\t");
    if (kind === "external") boundaries.external.push(new RegExp(name));
    if (kind === "internal") boundaries.internal.add(name);
  }

  return boundaries;
}

function readCounts(): Map<string, Record<string, number>> {
  const path = join(FORMAL, ".lake/conform/traces/_counts.txt");
  const totals = new Map<string, Record<string, number>>();
  if (!existsSync(path)) return totals;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const { fn, ...row } = JSON.parse(line) as {
      fn: string;
    } & Record<string, number>;
    const total = totals.get(fn) ?? {};
    totals.set(fn, total);
    for (const [key, value] of Object.entries(row))
      total[key] = (total[key] ?? 0) + value;
  }

  return totals;
}

function unobservedByFunction(rows: Row[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (!isSource(row.path)) continue;
    const analysis = analyzed(row.path);
    for (const fn of analysis.functions) {
      const node = functionNode(analysis.program, fn);
      if (node) out.set(fn.source, unobservedCalls(node));
    }
  }

  return out;
}

const analyses = new Map<string, FileAnalysis>();

function analyzed(path: string): FileAnalysis {
  let analysis = analyses.get(path);
  if (!analysis) {
    analysis = analyzeFile(path, readFileSync(join(ROOT, path), "utf8"));
    analyses.set(path, analysis);
  }

  return analysis;
}

function isSource(path: string): boolean {
  return /\.(ts|mjs)$/.test(path) && !path.endsWith(".d.ts");
}

function readExclusions(): Exclusion[] {
  const directory = join(FORMAL, "exclusions.d");
  const paths = [
    join(FORMAL, "exclusions.tsv"),
    ...(existsSync(directory)
      ? readdirSync(directory).map((file) => join(directory, file))
      : []),
  ].filter((path) => existsSync(path));

  return paths
    .flatMap((path) => readFileSync(path, "utf8").split("\n").slice(1))
    .filter(Boolean)
    .map((line) => {
      const [pattern = "", category = ""] = line.split("\t");

      return { pattern: pattern, category: category };
    });
}

// A function counts as replayed if a replay file names it or it is called, within its own file,
// from one that does. Anything else a suite merely ran on the way is not credited.
function replayReachable(analysis: FileAnalysis, text: string): Set<string> {
  const names = new Map(
    analysis.functions.map((fn) => [fn.name.split(".").at(-1) ?? "", fn]),
  );
  const reachable = new Set<string>();
  const stack = analysis.functions.filter((fn) =>
    new RegExp(`\\b${fn.name.split(".").at(-1) ?? ""}\\b`).test(text),
  );
  while (stack.length > 0) {
    const fn = stack.pop();
    if (!fn || reachable.has(fn.source)) continue;
    reachable.add(fn.source);
    const node = functionNode(analysis.program, fn);
    if (!node) continue;
    for (const name of calledNames(node)) {
      const callee = names.get(name);
      if (callee) stack.push(callee);
    }
  }

  return reachable;
}

function calledNames(node: AstNode): Set<string> {
  const names = new Set<string>();
  const visit = (current: AstNode): void => {
    if (current.type === "CallExpression") {
      const callee = current["callee"] as AstNode;
      if (callee.type === "Identifier") names.add(callee["name"] as string);
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if ((item as AstNode | null)?.type) visit(item as AstNode);
        }
      } else if ((value as AstNode | null)?.type) {
        visit(value as AstNode);
      }
    }
  };
  visit(node);

  return names;
}

function replayFilesText(): string {
  return walk(join(FORMAL, "replay"), ".ts")
    .filter((path) => !/instrument|record-preload|mutate-preload/.test(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

// Executable statements checked against the model, out of those that can be. A statement counts as
// checked if it ran during a call a credited twin matched, or during replay of a function replay
// names. Exclusions are per function, each with a category and reason in `exclusions.tsv`.
function report(
  rows: Row[],
  coverage: Map<string, LineCounts>,
  failures: string[],
): void {
  const credited = creditedTwins(rows, failures);
  const hitsByFile = new Map<
    string,
    { hits: Set<number>; arms: Set<number> }
  >();
  for (const twin of credited.values()) {
    const file = twin.source.split("#")[0] ?? "";
    const entry = hitsByFile.get(file) ?? { hits: new Set(), arms: new Set() };
    hitsByFile.set(file, entry);
    for (const offset of twin.hits) {
      entry.hits.add(offset);
      entry.arms.add(offset);
    }
    for (const offset of twin.impliedElse) entry.arms.add(offset);
  }
  const exclusions = readExclusions();
  const replayText = replayFilesText();
  const groups = [...new Set(rows.map((row) => row.subsystem))].sort();
  const header = [
    "subsystem",
    "statements",
    "excluded",
    "verifiable",
    "verified",
    "by twin",
    "by replay",
    "branch arms",
  ];
  const table: string[][] = [header];
  const totals = emptyTally();
  const categories = new Map<string, number>();
  const unverified: { source: string; count: number }[] = [];
  for (const group of groups) {
    const line = emptyTally();
    for (const row of rows.filter((entry) => entry.subsystem === group)) {
      if (!isSource(row.path)) continue;
      const analysis = analyzed(row.path);
      const hit = coverage.get(row.path)?.hit ?? new Set<number>();
      const reachable = replayReachable(analysis, replayText);
      const perFunction = new Map<string, number>();
      for (const site of analysis.statements) {
        line.statements += 1;
        const category = excludedCategory(exclusions, row.path, site.owner);
        if (category) {
          line.excluded += 1;
          categories.set(category, (categories.get(category) ?? 0) + 1);
          continue;
        }
        line.verifiable += 1;
        // Offsets are per file, so a private method credits through the method that called it.
        const twin =
          hitsByFile.get(row.path)?.hits.has(site.node.start) ?? false;
        const replayed =
          hit.has(site.line) &&
          (site.owner === undefined
            ? replayText.includes(row.path)
            : reachable.has(site.owner));
        if (twin) line.byTwin += 1;
        else if (replayed) line.byReplay += 1;
        if (twin || replayed) line.verified += 1;
        else {
          const key = site.owner ?? `${row.path}#<unlisted>`;
          perFunction.set(key, (perFunction.get(key) ?? 0) + 1);
        }
      }
      for (const [source, count] of perFunction)
        unverified.push({ source: source, count: count });
      for (const arm of analysis.arms) {
        if (excludedCategory(exclusions, row.path, arm.owner)) continue;
        line.arms += 1;
        if (hitsByFile.get(row.path)?.arms.has(arm.node.start))
          line.armsVerified += 1;
      }
    }
    for (const key of Object.keys(totals) as (keyof Tally)[])
      totals[key] += line[key];
    table.push(tableRow(group, line));
  }
  table.push(tableRow("all", totals));
  for (const row of table) {
    console.log(
      row
        .map((cell, index) =>
          index === 0 ? cell.padEnd(10) : cell.padStart(15),
        )
        .join(" "),
    );
  }
  console.log(
    `${credited.size} twins credited. ${percent(totals.verified, totals.statements)} of all statements, ${percent(totals.verified, totals.verifiable)} of verifiable.`,
  );
  writeFileSync(
    join(FORMAL, "coverage.json"),
    `${JSON.stringify(
      {
        totals: totals,
        twins: credited.size,
        creditedTwins: [...credited.keys()].sort(),
        excludedByCategory: Object.fromEntries(categories),
        table: table,
        largestUnverified: unverified
          .sort((a, b) => b.count - a.count)
          .slice(0, 200),
      },
      null,
      1,
    )}\n`,
  );
}

function excludedCategory(
  exclusions: Exclusion[],
  path: string,
  owner: string | undefined,
): string | undefined {
  return exclusions.find(
    (entry) =>
      entry.pattern === owner ||
      entry.pattern === `${path}#*` ||
      (owner === undefined && entry.pattern === `${path}#<unlisted>`),
  )?.category;
}

function emptyTally(): Tally {
  return {
    statements: 0,
    excluded: 0,
    verifiable: 0,
    verified: 0,
    byTwin: 0,
    byReplay: 0,
    arms: 0,
    armsVerified: 0,
  };
}

function tableRow(name: string, line: Tally): string[] {
  return [
    name,
    String(line.statements),
    String(line.excluded),
    String(line.verifiable),
    percent(line.verified, line.verifiable),
    String(line.byTwin),
    String(line.byReplay),
    `${line.armsVerified}/${line.arms}`,
  ];
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;
}

function walk(directory: string, extension: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path, extension);

    return path.endsWith(extension) ? [path] : [];
  });
}

// One pass, so a string holding `--` cannot be mistaken for a comment or the reverse.
function stripLeanComments(text: string): string {
  // A character literal goes first: `'"'` would otherwise flip what counts as inside a string.
  return text.replace(
    /'(?:[^'\\\n]|\\[^\n]+?)'|"(?:[^"\\]|\\.)*"|\/-[\s\S]*?-\/|--[^\n]*/g,
    '""',
  );
}

main();
