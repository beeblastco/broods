import { appendFileSync, existsSync, readFileSync } from "node:fs";
import budgetJson from "./comment-density.json" with { type: "json" };

export const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|jsx)$/;
export const JSX_FILE = /\.[jt]sx$/;

export interface Token {
  text: string;
  start: number;
}

export interface Comment {
  start: number;
  end: number;
}

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

const OPERATOR_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const WHITESPACE = /\s+/y;
const WORD = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*|\.?\d[\w.]*/y;
const JSX_START = /<[A-Za-z_$>]/y;
// In a .tsx file `<T,>` and `<T extends U>` open type parameters, not an element.
const TSX_GENERIC = /<[A-Za-z_$][\w$]*\s*(?:,|extends\b)/y;
const JSX_NAME = /[A-Za-z_$][\w$.:-]*/y;
const JSX_TEXT = /[^<{]+/y;
const REGEX_FLAGS = /[a-z]*/y;
const BLANK_STRING = /^(["'])\s*\1$/;

function sticky(
  pattern: RegExp,
  source: string,
  at: number,
): string | undefined {
  pattern.lastIndex = at;

  return pattern.exec(source)?.[0];
}

// Strings, templates, regex literals and JSX text are skipped whole, so `//` in
// them is no comment. JSX text and empty JSX children yield no token.
export function scan(
  source: string,
  jsx: boolean,
): { tokens: Token[]; comments: Comment[] } {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let i = 0;
  let afterOperand = false;

  const emit = (start: number, operand: boolean): void => {
    tokens.push({ text: source.slice(start, i), start: start });
    afterOperand = operand;
  };
  const lineEnd = (from: number): number => {
    const end = source.indexOf("\n", from);

    return end === -1 ? source.length : end;
  };

  function trivia(): void {
    for (;;) {
      i += sticky(WHITESPACE, source, i)?.length ?? 0;
      const start = i;
      if (source.startsWith("//", i)) {
        i = lineEnd(i);
      } else if (source.startsWith("/*", i)) {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? source.length : close + 2;
      } else {
        return;
      }
      comments.push({ start: start, end: i });
    }
  }

  function code(nested: boolean): void {
    let depth = 0;
    for (trivia(); i < source.length; trivia()) {
      const char = source.charAt(i);
      if (char === "{") depth++;
      if (char === "}" && depth-- === 0 && nested) {
        i++;
        emit(i - 1, true);

        return;
      }
      token(char);
    }
  }

  function token(char: string): void {
    const start = i;
    if (char === '"' || char === "'") {
      quoted(char);
    } else if (char === "`") {
      template();
    } else if (char === "/" && !afterOperand && regex()) {
      emit(start, true);
    } else if (char === "<" && jsx && !afterOperand && jsxStart()) {
      element();
    } else {
      const word = sticky(WORD, source, i);
      i += word?.length ?? (source.startsWith("=>", i) ? 2 : 1);
      const closes = char === ")" || char === "]" || char === "}";
      emit(start, word === undefined ? closes : !OPERATOR_KEYWORDS.has(word));
    }
  }

  function quoted(quote: string): void {
    const start = i++;
    while (i < source.length) {
      const char = source.charAt(i);
      i += char === "\\" ? 2 : 1;
      if (char === quote || char === "\n") break;
    }
    emit(start, true);
  }

  function template(): void {
    let start = i++;
    while (i < source.length && source.charAt(i) !== "`") {
      if (source.startsWith("${", i)) {
        i += 2;
        emit(start, false);
        code(true);
        start = i;
      } else {
        i += source.charAt(i) === "\\" ? 2 : 1;
      }
    }
    i++;
    emit(start, true);
  }

  function regex(): boolean {
    let inClass = false;
    for (let j = i + 1; j < source.length; j++) {
      const char = source.charAt(j);
      if (char === "\n") return false;
      if (char === "\\") j++;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        i = j + 1;
        i += sticky(REGEX_FLAGS, source, i)?.length ?? 0;

        return true;
      }
    }

    return false;
  }

  const jsxStart = (): boolean =>
    sticky(JSX_START, source, i) !== undefined &&
    sticky(TSX_GENERIC, source, i) === undefined;

  function element(): void {
    i++;
    emit(i - 1, false);
    for (trivia(); i < source.length; trivia()) {
      const start = i;
      const char = source.charAt(i);
      if (char === ">" || source.startsWith("/>", i)) {
        i += char === ">" ? 1 : 2;
        emit(start, true);
        if (char === ">") children();

        return;
      }
      if (char === "<") {
        element();
        continue;
      }
      if (char === '"' || char === "'") {
        const close = source.indexOf(char, i + 1);
        i = close === -1 ? source.length : close + 1;
      } else {
        i += sticky(JSX_NAME, source, i)?.length ?? 1;
      }
      emit(start, false);
      if (char === "{") code(true);
    }
  }

  function children(): void {
    while (i < source.length) {
      const start = i;
      if (source.startsWith("</", i)) {
        const close = source.indexOf(">", i);
        i = close === -1 ? source.length : close + 1;
        emit(start, true);

        return;
      }
      if (source.charAt(i) === "<") element();
      else if (source.charAt(i) === "{") container();
      else i += sticky(JSX_TEXT, source, i)?.length ?? 1;
    }
  }

  function container(): void {
    const mark = tokens.length;
    i++;
    emit(i - 1, false);
    code(true);
    const inner = tokens.slice(mark + 1, -1);
    if (inner.every((entry) => BLANK_STRING.test(entry.text))) {
      tokens.length = mark;
    }
  }

  if (source.startsWith("#!")) {
    i = lineEnd(0);
    emit(0, false);
  }
  code(false);

  return { tokens: tokens, comments: comments };
}

const blockText = (line: string): string =>
  line.replace(/^\s*\*?\s?/, "").trim();

// Counted like the density baseline: a `//` comment alone on its line, and each
// non-blank line of a block comment that opens its line or follows `{`.
export function commentLines(source: string, jsx: boolean): number {
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
  for (const { start, end } of scan(source, jsx).comments) {
    while ((lineStarts[line + 1] ?? Infinity) <= start) line++;
    const prefix = source.slice(lineStarts[line], start).trim();
    if (source.startsWith("//", start)) {
      if (prefix === "" && source.slice(start + 2, end).trim() !== "") {
        counted.add(line);
      }
      continue;
    }
    if (prefix !== "" && prefix !== "{") continue;
    const closed = end - start >= 4 && source.endsWith("*/", end);
    const body = source.slice(start + 2, closed ? end - 2 : end).split("\n");
    body.forEach((text, offset) => {
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
        comments: commentLines(source, JSX_FILE.test(path)),
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
  const args = process.argv.slice(2);
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const budget: Budget = budgetJson;
  const report = judge(measure(root), budget);
  const json = args.includes("--json");
  console.log(json ? JSON.stringify(report, null, 2) : renderText(report));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, renderMarkdown(report));
  if (args.includes("--check")) {
    for (const failure of report.failures)
      console.error(`over budget: ${failure}`);
    if (report.failures.length > 0) process.exit(1);
    if (!json) console.log("comment density within budget");
  }
}
