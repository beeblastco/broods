import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import budgetJson from "./comment-density.json" with { type: "json" };

export const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|jsx)$/;

export interface Budget {
  maxPct: number;
  workspaceMaxPct: number;
  workspaceExceptions: Record<string, { maxPct: number; why: string }>;
}

export interface FileDensity {
  path: string;
  lines: number;
  comments: number;
}

export interface Row {
  name: string;
  files: number;
  lines: number;
  comments: number;
  maxPct: number;
  cut: number;
}

export interface Report {
  total: Row;
  workspaces: Row[];
  top: FileDensity[];
  failures: string[];
}

const blockText = (line: string): string =>
  line.replace(/^\s*\*?\s?/, "").trim();

// Counted like the density baseline: a `//` comment alone on its line, and each
// non-blank line of a block comment that opens its line or follows `{`.
export function commentLines(path: string, source: string): number {
  const lineStarts = [0];
  for (
    let at = source.indexOf("\n");
    at !== -1;
    at = source.indexOf("\n", at + 1)
  ) {
    lineStarts.push(at + 1);
  }
  const counted = new Set<number>();
  let line = 0;
  for (const { type, value, start } of parseSync(path, source).comments) {
    while ((lineStarts[line + 1] ?? Infinity) <= start) line++;
    const prefix = source.slice(lineStarts[line], start).trim();
    if (type === "Line") {
      if (prefix === "" && value.trim() !== "") counted.add(line);
      continue;
    }
    if (prefix !== "" && prefix !== "{") continue;
    value.split("\n").forEach((text, offset) => {
      if (blockText(text) !== "") counted.add(line + offset);
    });
  }

  return counted.size;
}

export function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: cwd });
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")}: ${result.stderr.toString().trim()}`,
    );
  }

  return result.stdout.toString();
}

export function measure(root: string): FileDensity[] {
  return git(["ls-files", "-z"], root)
    .split("\0")
    .filter(
      (path) =>
        SOURCE_FILE.test(path) &&
        !/(?:^|\/)_generated\//.test(path) &&
        !path.endsWith(".d.ts") &&
        existsSync(`${root}/${path}`),
    )
    .map((path) => {
      const source = readFileSync(`${root}/${path}`, "utf8");

      return {
        path: path,
        lines: source.split("\n").length,
        comments: commentLines(path, source),
      };
    });
}

export function workspaceOf(path: string): string {
  const [top = path, name, ...rest] = path.split("/");
  if (name === undefined) return "(root)";

  return (top === "apps" || top === "packages") && rest.length > 0
    ? `${top}/${name}`
    : top;
}

const percent = (row: { lines: number; comments: number }): number =>
  row.lines === 0 ? 0 : (100 * row.comments) / row.lines;

function row(name: string, files: FileDensity[], maxPct: number): Row {
  const lines = files.reduce((sum, file) => sum + file.lines, 0);
  const comments = files.reduce((sum, file) => sum + file.comments, 0);
  // Cutting a comment line also shrinks the total, hence the code-lines base.
  const keep = Math.floor((maxPct * (lines - comments)) / (100 - maxPct));

  return {
    name: name,
    files: files.length,
    lines: lines,
    comments: comments,
    maxPct: maxPct,
    cut: Math.max(0, comments - keep),
  };
}

export function judge(files: FileDensity[], budget: Budget): Report {
  const groups = Map.groupBy(files, (file) => workspaceOf(file.path));
  const workspaces = [...groups]
    .map(([name, members]) =>
      row(
        name,
        members,
        budget.workspaceExceptions[name]?.maxPct ?? budget.workspaceMaxPct,
      ),
    )
    .sort((a, b) => b.comments - a.comments);
  const total = row("total", files, budget.maxPct);
  const failures = [total, ...workspaces]
    .filter((entry) => entry.cut > 0)
    .map(
      (entry) =>
        `${entry.name} ${percent(entry).toFixed(2)}% > ${entry.maxPct}%: cut ${entry.cut} comment lines`,
    );
  const top = files.toSorted((a, b) => b.comments - a.comments).slice(0, 15);

  return { total: total, workspaces: workspaces, top: top, failures: failures };
}

const HEADER = [
  "workspace",
  "files",
  "lines",
  "comments",
  "%",
  "budget",
  "cut",
];

const tableRows = (report: Report): string[][] =>
  [report.total, ...report.workspaces].map((entry) => [
    entry.name,
    String(entry.files),
    String(entry.lines),
    String(entry.comments),
    `${percent(entry).toFixed(2)}%`,
    `${entry.maxPct}%`,
    String(entry.cut),
  ]);

function renderText(report: Report): string {
  const table = [HEADER, ...tableRows(report)].map((cells) =>
    cells
      .map((cell, index) => (index === 0 ? cell.padEnd(26) : cell.padStart(9)))
      .join(""),
  );
  const top = report.top.map(
    (file) =>
      `${String(file.comments).padStart(6)} ${percent(file).toFixed(1).padStart(5)}%  ${file.path}`,
  );

  return [...table, "", "top files by comment lines:", ...top].join("\n");
}

function renderMarkdown(report: Report): string {
  const verdict =
    report.failures.length === 0 ? "within budget" : "over budget";

  return [
    `### Comment density ${percent(report.total).toFixed(2)}%: ${verdict}`,
    "",
    `| ${HEADER.join(" | ")} |`,
    `| --- |${" ---: |".repeat(HEADER.length - 1)}`,
    ...tableRows(report).map((cells) => `| ${cells.join(" | ")} |`),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const budget: Budget = budgetJson;
  const report = judge(measure(root), budget);
  const json = args.has("--json");
  console.log(json ? JSON.stringify(report, null, 2) : renderText(report));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, renderMarkdown(report));
  if (args.has("--check")) {
    for (const failure of report.failures)
      console.error(`over budget: ${failure}`);
    if (report.failures.length > 0) process.exit(1);
    if (!json) console.log("comment density within budget");
  }
}
