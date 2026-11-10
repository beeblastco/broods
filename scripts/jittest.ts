import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./comment-density.ts";
import { verify } from "./comment-only-diff.ts";

// The policy a maintainer tunes from the aggregate report: nobody reviews single tests.
const GENERATOR_MODEL = "claude-sonnet-5-5";
const JUDGE_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
];
const GENERATOR_BUDGET_USD = 6;
const JUDGE_BUDGET_USD = 1;
const MAX_FILES = 12;
const MAX_TESTS_PER_WORKFLOW = 4;
const REPORT_AT = 0.5;
const PATTERN_BONUS = 0.5;
const RUN_TIMEOUT_MS = 180_000;
const CLIP = 40_000;

const WORKSPACES: Record<string, Workspace> = {
  "apps/core": {
    prepare: ["bun", "run", "scripts/compaction-prompt.ts"],
    run: ["bun", "test", "--isolate", "--max-concurrency=1"],
  },
  "apps/gateway": { run: ["bun", "test"] },
  "apps/edge": { run: ["bun", "test"] },
  "apps/discord-forwarder": { run: ["bun", "test"] },
  "apps/cloudflare-mcp": { run: ["bun", "test"] },
  "apps/cloudflare-worker": { run: ["bun", "test"] },
  "packages/broods": { run: ["bun", "test"] },
  "packages/ai-sdk-sandbox": { run: ["bun", "test"] },
  "packages/convex": { run: ["bun", "x", "vitest", "run"] },
};

const NOT_SOURCE =
  /(?:^|\/)(?:tests?|e2e|scripts|_generated)\/|\.test\.|\.d\.ts$/;
const TEST_FILE = /\/tests\/jittest\/[\w.-]+\.test\.ts$/;
const MUTANT_FILE = /^\.jittest\/mutants\/[\w.-]+\.patch$/;

// Failures that are the test's fault or an intended API change, by where the sign shows.
const FALSE_POSITIVE_RULES: Rule[] = [
  {
    name: "broken_test_runner",
    source: "log",
    pattern: /Cannot find (?:module|package)|Could not resolve|SyntaxError/,
  },
  {
    name: "type_mismatch",
    source: "log",
    pattern: /TypeError: .*is not a (?:function|constructor)/,
  },
  { name: "undefined_variable", source: "log", pattern: /ReferenceError/ },
  {
    name: "not_implemented_exception",
    source: "log",
    pattern: /not (?:yet )?implemented/i,
  },
  {
    name: "web_server_down",
    source: "log",
    pattern: /ECONNREFUSED|ENOTFOUND|fetch failed|Unable to connect/,
  },
  { name: "flakiness", source: "log", pattern: /timed out|timeout of \d+/i },
  {
    name: "reflection",
    source: "test",
    pattern: /\bas any\b|\bas unknown as\b|\[["']_/,
  },
  {
    name: "mock_broken",
    source: "test",
    pattern: /\b(?:mock\.module|vi\.mock|spyOn)\(/,
  },
  {
    name: "expecting_particular_calls_to_functions",
    source: "test",
    pattern: /toHaveBeen(?:Nth)?Called/,
  },
];

// Intents under which any change to existing behavior is suspect.
const TRUE_POSITIVE_PATTERNS: Partial<Record<IntentKind, string>> = {
  refactor: "refactor",
  "dead-code-removal": "dead_code_removal",
  "add-behavior": "monotonic_change",
};

const LIKELIHOOD_SCORE: Record<Likelihood, number> = {
  high: 1,
  medium: 0,
  low: -1,
};

const GENERATION_SCHEMA = {
  type: "object",
  required: ["intent", "kind", "risks", "tests"],
  properties: {
    intent: { type: "string" },
    kind: {
      enum: [
        "refactor",
        "dead-code-removal",
        "add-behavior",
        "change-behavior",
        "fix",
      ],
    },
    risks: { type: "array", items: { type: "string" } },
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "workflow", "risk", "behavior"],
        properties: {
          file: { type: "string" },
          workflow: { enum: ["intent-aware", "dodgy-diff"] },
          risk: { type: "string" },
          behavior: { type: "string" },
          mutant: { type: "string" },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: "object",
  required: ["likelihood", "change", "unexpected"],
  properties: {
    likelihood: { enum: ["high", "medium", "low"] },
    change: { type: "string" },
    unexpected: { type: "string" },
  },
};

type IntentKind =
  | "refactor"
  | "dead-code-removal"
  | "add-behavior"
  | "change-behavior"
  | "fix";

type Likelihood = "high" | "medium" | "low";

export type Outcome =
  | "weak-catch"
  | "passes"
  | "fails-on-parent"
  | "mutant-survives"
  | "flaky"
  | "invalid";

interface Workspace {
  prepare?: string[];
  run: string[];
}

interface Rule {
  name: string;
  source: "log" | "test";
  pattern: RegExp;
}

export interface GeneratedTest {
  file: string;
  workflow: "intent-aware" | "dodgy-diff";
  risk: string;
  behavior: string;
  mutant?: string;
}

export interface Generation {
  intent: string;
  kind: IntentKind;
  risks: string[];
  tests: GeneratedTest[];
}

export interface Verdict {
  model: string;
  likelihood: Likelihood;
  change: string;
  unexpected: string;
}

export interface Assessment {
  rule: string | undefined;
  pattern: string | undefined;
  verdicts: Verdict[];
  score: number;
}

export interface Candidate extends GeneratedTest {
  outcome: Outcome;
  code: string;
  output: string;
  assessment?: Assessment;
}

interface Args {
  base: string | undefined;
  title: string | undefined;
  summary: string | undefined;
  out: string;
}

interface ClaudeResult<T> {
  type: string;
  is_error?: boolean;
  result?: string;
  structured_output?: T;
  total_cost_usd?: number;
}

interface Run {
  ok: boolean;
  output: string;
}

/** Generates catching tests for the change against `base` and reports behavior it broke. */
export function jittest(root: string, base: string, args: Args): void {
  const files = targets(root, base);
  if (files.length === 0) {
    console.log("jittest: no runtime change in a tested workspace, skipped");
    return;
  }
  const diff = git(["diff", base, "--", ...files], root);
  const title =
    args.title ?? git(["log", "--format=%s", `${base}..HEAD`], root).trim();
  const parent = mkdtempSync(join(tmpdir(), "jittest-"));
  const used = [...new Set(files.map(workspaceOf))].filter(
    (workspace) => workspace !== undefined,
  );
  let cost = 0;
  try {
    git(["worktree", "add", "--detach", parent, base], root);
    must(
      exec(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], parent),
      "bun install in the parent worktree",
    );
    for (const side of [parent, root]) {
      for (const workspace of used) {
        const prepare = WORKSPACES[workspace]?.prepare;
        if (prepare !== undefined) {
          must(exec(prepare, join(side, workspace)), prepare.join(" "));
        }
      }
    }
    mkdirSync(join(parent, ".jittest/mutants"), { recursive: true });
    writeFileSync(join(parent, ".jittest/change.diff"), diff);
    writeFileSync(
      join(parent, ".jittest/change.md"),
      `# ${title}\n\n${args.summary ?? ""}\n`,
    );

    const generated = claude<Generation>({
      cwd: parent,
      model: GENERATOR_MODEL,
      budget: GENERATOR_BUDGET_USD,
      prompt: generatorPrompt(files),
      schema: GENERATION_SCHEMA,
      tools: ["--allowedTools", "Bash,Read,Edit,Write,Glob,Grep"],
    });
    cost += generated.cost;
    const generation = generated.output;

    const candidates = generation.tests.map((test): Candidate =>
      harvest(test, parent, root),
    );
    for (const candidate of candidates) {
      if (candidate.outcome !== "weak-catch") continue;
      const rule = falsePositiveRule(candidate.code, candidate.output);
      const verdicts: Verdict[] = [];
      for (const model of rule === undefined ? JUDGE_MODELS : []) {
        const judged = claude<Omit<Verdict, "model">>({
          cwd: parent,
          model: model,
          budget: JUDGE_BUDGET_USD,
          prompt: judgePrompt(generation, diff, candidate),
          schema: VERDICT_SCHEMA,
          tools: ["--tools", ""],
        });
        cost += judged.cost;
        verdicts.push({ model: model, ...judged.output });
      }
      const pattern = TRUE_POSITIVE_PATTERNS[generation.kind];
      candidate.assessment = {
        rule: rule,
        pattern: pattern,
        verdicts: verdicts,
        score: score(rule, pattern, verdicts),
      };
    }

    const summary = renderSummary(generation, candidates, cost);
    const comment = renderComment(generation, candidates);
    mkdirSync(args.out, { recursive: true });
    writeFileSync(
      join(args.out, "report.json"),
      JSON.stringify(
        {
          base: base,
          cost: cost,
          generation: generation,
          candidates: candidates,
        },
        null,
        2,
      ),
    );
    rmSync(join(args.out, "comment.md"), { force: true });
    if (comment !== undefined) {
      writeFileSync(join(args.out, "comment.md"), comment);
    }
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, {
        flag: "a",
      });
    }
  } finally {
    for (const workspace of used) {
      rmSync(join(root, workspace, "tests/jittest"), {
        recursive: true,
        force: true,
      });
    }
    Bun.spawnSync(["git", "worktree", "remove", "--force", parent], {
      cwd: root,
    });
    rmSync(parent, { recursive: true, force: true });
  }
}

/** The first false-positive rule a failing test matches, from its code or its failure log. */
export function falsePositiveRule(
  code: string,
  output: string,
): string | undefined {
  return FALSE_POSITIVE_RULES.find((rule) =>
    rule.pattern.test(rule.source === "log" ? output : code),
  )?.name;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? -1;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    base: undefined,
    title: process.env.JITTEST_TITLE,
    summary: process.env.JITTEST_SUMMARY,
    out: ".jittest",
  };
  const queue = [...argv];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    const value = queue.shift();
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    if (arg === "--base") args.base = value;
    else if (arg === "--title") args.title = value;
    else if (arg === "--summary") args.summary = value;
    else if (arg === "--out") args.out = value;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

/** The pull request comment: one question per catch that scored high enough, else nothing. */
export function renderComment(
  generation: Generation,
  candidates: Candidate[],
): string | undefined {
  const reported = candidates
    .filter((candidate) => (candidate.assessment?.score ?? -1) >= REPORT_AT)
    .sort(
      (left, right) =>
        (right.assessment?.score ?? 0) - (left.assessment?.score ?? 0),
    );
  if (reported.length === 0) return undefined;
  const block = (title: string, language: string, text: string): string[] => [
    `<details><summary>${title}</summary>`,
    "",
    `\`\`\`${language}`,
    clip(text).replaceAll("```", "'''"),
    "```",
    "",
    "</details>",
  ];

  return [
    `### JiTTest: ${reported.length} behavior change(s) to confirm`,
    "",
    `Read intent: ${generation.intent}`,
    "",
    "Each test below passes on the base and fails on this change. Reply if the change is intended; no need to read the test.",
    ...reported.flatMap((candidate) => {
      const verdict = representative(candidate.assessment?.verdicts ?? []);

      return [
        "",
        `**${verdict?.change ?? candidate.behavior} Is that expected?**`,
        "",
        verdict?.unexpected ?? candidate.risk,
        "",
        ...block(candidate.file, "ts", candidate.code),
        ...block("Failure", "text", candidate.output),
      ];
    }),
  ].join("\n");
}

/** -1 a false positive, +1 a real regression; a true-positive pattern lifts a split vote. */
export function score(
  rule: string | undefined,
  pattern: string | undefined,
  verdicts: Verdict[],
): number {
  if (rule !== undefined || verdicts.length === 0) return -1;
  const votes = verdicts.map((verdict) => LIKELIHOOD_SCORE[verdict.likelihood]);

  return median(votes) + (pattern === undefined ? 0 : PATTERN_BONUS);
}

export function workspaceOf(path: string): string | undefined {
  return Object.keys(WORKSPACES).find((workspace) =>
    path.startsWith(`${workspace}/`),
  );
}

function clip(text: string): string {
  return text.length > CLIP ? `${text.slice(0, CLIP)}\n[clipped]` : text;
}

function claude<T>(options: {
  cwd: string;
  model: string;
  budget: number;
  prompt: string;
  schema: object;
  tools: string[];
}): { output: T; cost: number } {
  const result = Bun.spawnSync(
    [
      "claude",
      "-p",
      "--model",
      options.model,
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--max-budget-usd",
      String(options.budget),
      "--json-schema",
      JSON.stringify(options.schema),
      ...options.tools,
    ],
    { cwd: options.cwd, stdin: Buffer.from(options.prompt) },
  );
  const stdout = result.stdout.toString();
  if (!result.success && stdout.trim() === "") {
    throw new Error(`claude: ${result.stderr.toString().trim()}`);
  }
  const parsed = JSON.parse(stdout) as ClaudeResult<T> | ClaudeResult<T>[];
  const last = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (last?.structured_output === undefined || last.is_error === true) {
    throw new Error(`claude ${options.model}: ${last?.result ?? "no result"}`);
  }

  return { output: last.structured_output, cost: last.total_cost_usd ?? 0 };
}

// The model key stays out of generated tests.
function exec(command: string[], cwd: string): Run {
  const result = Bun.spawnSync(command, {
    cwd: cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    timeout: RUN_TIMEOUT_MS,
  });

  return {
    ok: result.success,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function generatorPrompt(files: string[]): string {
  const runners = Object.entries(WORKSPACES)
    .map(([path, workspace]) => `- ${path}: \`${workspace.run.join(" ")}\``)
    .join("\n");

  return `You write just-in-time catching tests for one code change. This checkout is the PARENT revision: the change is not applied here and you must never apply it.

The change is in .jittest/change.diff (unified diff, parent to child). Its title and summary are in .jittest/change.md.

Work in this order.

1. Intent. Read the diff and the code around it. State in one or two sentences what the change means to do, and classify it: refactor, dead-code-removal, add-behavior, change-behavior or fix.

2. Risks. List the ways an implementation of that intent could go wrong: concrete behaviors of the parent that must survive the change and could plausibly break. Leave out behavior the intent means to change.

3. Intent-aware tests, for at most ${MAX_TESTS_PER_WORKFLOW} of the most severe risks:
   a. Build a mutant. Edit the parent source to introduce exactly that bug, save it with \`git diff > .jittest/mutants/<n>.patch\`, then \`git checkout -- <files>\` so the checkout is the parent again.
   b. Write one test file that passes on the parent and fails with the mutant applied. Prove both with \`git apply .jittest/mutants/<n>.patch\`, a run, and \`git apply -R\`.

4. Dodgy-diff tests, at most ${MAX_TESTS_PER_WORKFLOW}. Treat the diff itself as a possible mutant of the parent. Write tests that pin parent behavior the diff touches and that you expect to differ after the change, where the intent does not ask for that difference. These have no patch.

Every test:
- lives at <workspace>/tests/jittest/<name>.test.ts, one behavior per file;
- asserts observable behavior through exported functions: return values, thrown errors, stored state. Never private members, casts that reach internals, module mocks, call counts or order, snapshots, timing or the network;
- is deterministic and follows the neighbouring files in <workspace>/tests for imports, helpers and style;
- passes on this checkout. Run it from the workspace directory with the runner below plus the path \`tests/jittest/<name>.test.ts\`. Drop a test you cannot make pass.

Change nothing outside tests/jittest/ and .jittest/, and leave no mutant applied.

Runners:
${runners}

Changed files:
${files.map((file) => `- ${file}`).join("\n")}

Return the manifest: \`file\` and \`mutant\` are paths relative to the repository root, \`risk\` is the risk (or the expected difference) the test targets, \`behavior\` is the parent behavior it pins in one sentence.`;
}

// Parent must pass, the mutant must fail, then a failure on the child twice is a weak catch.
function harvest(
  test: GeneratedTest,
  parent: string,
  child: string,
): Candidate {
  const workspace = workspaceOf(test.file);
  const source = join(parent, test.file);
  const done = (outcome: Outcome, output: string): Candidate => ({
    ...test,
    outcome: outcome,
    code: existsSync(source) ? readFileSync(source, "utf8") : "",
    output: output,
  });
  if (
    workspace === undefined ||
    !TEST_FILE.test(test.file) ||
    !existsSync(source) ||
    (test.mutant !== undefined && !MUTANT_FILE.test(test.mutant))
  ) {
    return done("invalid", "");
  }
  const run = (side: string): Run =>
    exec(
      [
        ...(WORKSPACES[workspace]?.run ?? []),
        test.file.slice(workspace.length + 1),
      ],
      join(side, workspace),
    );

  const onParent = run(parent);
  if (!onParent.ok) return done("fails-on-parent", onParent.output);
  if (test.mutant !== undefined) {
    if (!exec(["git", "apply", test.mutant], parent).ok) {
      return done("invalid", "");
    }
    const onMutant = run(parent);
    must(exec(["git", "apply", "-R", test.mutant], parent), "revert mutant");
    if (onMutant.ok) return done("mutant-survives", onMutant.output);
  }

  const target = join(child, test.file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const onChild = run(child);
  if (onChild.ok) return done("passes", "");

  return run(child).ok
    ? done("flaky", onChild.output)
    : done("weak-catch", onChild.output);
}

function judgePrompt(
  generation: Generation,
  diff: string,
  candidate: Candidate,
): string {
  return `A generated test passes on the parent revision of a code change and fails on the changed revision. Decide whether the failure shows a bug the change introduced unexpectedly, or a false positive: behavior the change means to alter, or a fault in the test (wrong expectation, implementation detail, environment).

Intent of the change (${generation.kind}): ${generation.intent}

Behavior the test pins: ${candidate.behavior}

Diff, parent to child:
${clip(diff)}

Test (${candidate.file}):
${clip(candidate.code)}

Failure on the changed revision:
${clip(candidate.output)}

Answer with:
- likelihood: high, medium or low that this is an unexpected bug;
- change: one sentence stating the behavior change, as "<thing> used to <old>, now <new>.";
- unexpected: one sentence on why the intent does not explain the change, or why it does.`;
}

function must(run: Run, what: string): void {
  if (!run.ok) throw new Error(`${what} failed:\n${clip(run.output)}`);
}

function renderSummary(
  generation: Generation,
  candidates: Candidate[],
  cost: number,
): string {
  const row = (candidate: Candidate): string => {
    const assessment = candidate.assessment;
    const votes = assessment?.verdicts
      .map((verdict) => verdict.likelihood)
      .join(", ");

    return `| \`${candidate.file}\` | ${candidate.workflow} | ${candidate.outcome} | ${assessment?.rule ?? ""} | ${assessment?.pattern ?? ""} | ${votes ?? ""} | ${assessment?.score ?? ""} |`;
  };

  return [
    "## JiTTest",
    "",
    `Intent (${generation.kind}): ${generation.intent}`,
    "",
    ...generation.risks.map((risk) => `- risk: ${risk}`),
    "",
    "| test | workflow | outcome | false-positive rule | true-positive pattern | judges | score |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...candidates.map(row),
    "",
    `Reported at score >= ${REPORT_AT}. Model cost $${cost.toFixed(2)}.`,
  ].join("\n");
}

// The verdict the comment quotes: one that voted with the median.
function representative(verdicts: Verdict[]): Verdict | undefined {
  const middle = median(
    verdicts.map((verdict) => LIKELIHOOD_SCORE[verdict.likelihood]),
  );

  return verdicts.find(
    (verdict) => LIKELIHOOD_SCORE[verdict.likelihood] === middle,
  );
}

// Targeting: runtime changes to source of a workspace whose tests this can run.
function targets(root: string, base: string): string[] {
  const result = verify(root, base, new Set());

  return [
    ...result.changed
      .filter((change) => change.kind === "runtime")
      .map((change) => change.path),
    ...result.added,
  ]
    .filter((path) => workspaceOf(path) !== undefined && !NOT_SOURCE.test(path))
    .slice(0, MAX_FILES);
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
    const base = git(
      args.base === undefined
        ? ["merge-base", "HEAD", "origin/dev"]
        : ["rev-parse", "--verify", `${args.base}^{commit}`],
      root,
    ).trim();
    jittest(root, base, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "usage: bun scripts/jittest.ts [--base <ref>] [--title <text>] [--summary <text>] [--out <dir>]",
    );
    process.exit(2);
  }
}
