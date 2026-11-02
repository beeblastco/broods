import { readFileSync } from "node:fs";
import {
  git,
  JSX_FILE,
  scan,
  SOURCE_FILE,
  type Token,
} from "./comment-density.ts";

export interface CodeChange {
  kind: "runtime" | "types";
  where: string;
}

export type Verdict = { kind: "comment-only" } | CodeChange;

export interface Result {
  commentOnly: string[];
  added: string[];
  deleted: string[];
  allowed: (CodeChange & { path: string })[];
  changed: (CodeChange & { path: string })[];
}

// Comments that steer a tool are code for this check; a reason after `--` is not.
const DIRECTIVE = new RegExp(
  [
    String.raw`@ts-(?:ignore|expect-error|nocheck|check)\b`,
    String.raw`\b(?:ox|es)lint-(?:disable|enable)(?:-next-line|-line)?\b(?:[ \t]+(?!--)[\w@/-]+(?:[ \t]*,[ \t]*[\w@/-]+)*)?`,
    String.raw`\b(?:oxfmt|prettier|biome)-ignore\b`,
    String.raw`[@#]__(?:PURE|NO_SIDE_EFFECTS)__`,
    String.raw`@jsx\w*|@vite-ignore|webpack\w+:`,
  ].join("|"),
  "g",
);
const CLOSERS = new Set([")", "]", "}", ">"]);
// A leading `|` or `&` after these can only open a type, never an operator.
const TYPE_OPENERS = new Set(["=", ":", "<", ",", "[", "?", "=>"]);

function loaderOf(path: string): Bun.JavaScriptLoader {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";

  return /\.[cm]?ts$/.test(path) ? "ts" : "js";
}

function transpile(path: string, source: string): string {
  const transpiler = new Bun.Transpiler({
    loader: loaderOf(path),
    deadCodeElimination: false,
  });
  try {
    return transpiler.transformSync(source);
  } catch (error) {
    return `does not parse: ${String(error)}`;
  }
}

// Formatter reflow after a comment goes (parens, trailing commas and semicolons,
// a leading union bar) must not read as a change; Bun output covers runtime parens.
export function codeTokens(source: string, jsx: boolean): Token[] {
  const scanned = scan(source, jsx);
  const directives = scanned.comments.flatMap(({ start, end }) => {
    const text = source.slice(start, end);
    const found = /^\/\/\/\s*<(?:reference|amd)/.test(text)
      ? [text.trim()]
      : [...text.matchAll(DIRECTIVE)].map((match) => match[0]);

    return found.length === 0 ? [] : [{ text: found.join(" "), start: start }];
  });
  const tokens = [...scanned.tokens, ...directives].sort(
    (a, b) => a.start - b.start,
  );
  const kept: Token[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1]?.text ?? "";
    const previous = kept.at(-1)?.text ?? "";
    const reflow =
      token.text === "(" ||
      token.text === ")" ||
      (token.text === "," && CLOSERS.has(next)) ||
      (token.text === ";" && next === "}") ||
      ((token.text === "|" || token.text === "&") &&
        TYPE_OPENERS.has(previous));
    if (!reflow) kept.push(token);
  });

  return kept;
}

const lineOf = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

const clip = (text: string): string =>
  JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);

function firstDifference(
  before: string[],
  after: string[],
): number | undefined {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index++) {
    if (before[index] !== after[index]) return index;
  }

  return undefined;
}

export function compare(path: string, before: string, after: string): Verdict {
  const outBefore = transpile(path, before).split("\n");
  const outAfter = transpile(path, after).split("\n");
  const runtime = firstDifference(outBefore, outAfter);
  if (runtime !== undefined) {
    const was = clip(outBefore[runtime]?.trim() ?? "");
    const now = clip(outAfter[runtime]?.trim() ?? "");

    return {
      kind: "runtime",
      where: `transpiled line ${runtime + 1}: ${was} -> ${now}`,
    };
  }
  const jsx = JSX_FILE.test(path);
  const tokensBefore = codeTokens(before, jsx);
  const tokensAfter = codeTokens(after, jsx);
  const index = firstDifference(
    tokensBefore.map((token) => token.text),
    tokensAfter.map((token) => token.text),
  );
  if (index === undefined) return { kind: "comment-only" };
  const side = (source: string, token: Token | undefined): string =>
    token === undefined
      ? "end of file"
      : `line ${lineOf(source, token.start)} ${clip(token.text)}`;

  return {
    kind: "types",
    where: `${side(before, tokensBefore[index])} -> ${side(after, tokensAfter[index])}`,
  };
}

export function verify(root: string, base: string, allow: Set<string>): Result {
  const result: Result = {
    commentOnly: [],
    added: [],
    deleted: [],
    allowed: [],
    changed: [],
  };
  const fields = git(
    ["diff", "--name-status", "--no-renames", "-z", base],
    root,
  )
    .split("\0")
    .filter((field) => field !== "");
  const changes: [string, string][] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changes.push([fields[index] ?? "", fields[index + 1] ?? ""]);
  }
  for (const path of git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    root,
  ).split("\0")) {
    changes.push(["A", path]);
  }
  for (const [status, path] of changes) {
    if (!SOURCE_FILE.test(path)) continue;
    if (status === "A") {
      result.added.push(path);
    } else if (status === "D") {
      result.deleted.push(path);
    } else {
      const before = git(["cat-file", "blob", `${base}:${path}`], root);
      const after = readFileSync(`${root}/${path}`, "utf8");
      const verdict = compare(path, before, after);
      if (verdict.kind === "comment-only") {
        result.commentOnly.push(path);
      } else {
        const list = allow.has(path) ? result.allowed : result.changed;
        list.push({ path: path, ...verdict });
      }
    }
  }

  return result;
}

export function parseArgs(argv: string[]): {
  base: string | undefined;
  allow: Set<string>;
} {
  const queue = [...argv];
  let base: string | undefined;
  const allow = new Set<string>();
  let allowing = false;
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (arg === "--base" && queue[0] !== undefined) {
      base = queue.shift();
      allowing = false;
    } else if (arg === "--allow") {
      allowing = true;
    } else if (allowing && !arg.startsWith("--")) {
      allow.add(arg.replace(/^\.\//, ""));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { base: base, allow: allow };
}

function render(result: Result): string {
  const section = (title: string, rows: string[]): string[] =>
    rows.length === 0
      ? []
      : [`${title} (${rows.length}):`, ...rows.map((row) => `  ${row}`)];
  const describe = (entry: CodeChange & { path: string }): string =>
    `${entry.path}: ${entry.kind === "runtime" ? "runtime" : "types/directives"}, ${entry.where}`;

  return [
    ...section("comment-only", result.commentOnly),
    ...section("added, not checked", result.added),
    ...section("deleted", result.deleted),
    ...section("allowed code change", result.allowed.map(describe)),
    ...section("code changed", result.changed.map(describe)),
  ].join("\n");
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
    const result = verify(root, base, args.allow);
    console.log(
      `against ${base.slice(0, 12)} (${args.base ?? "merge-base with origin/dev"})`,
    );
    console.log(render(result));
    if (result.changed.length > 0) {
      console.error(
        `${result.changed.length} file(s) changed code; fix them or pass --allow <file> for an intended change`,
      );
      process.exit(1);
    }
    console.log(
      `no code changed in ${result.commentOnly.length + result.allowed.length} modified file(s)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "usage: bun scripts/comment-only-diff.ts [--base <ref>] [--allow <file> ...]",
    );
    process.exit(2);
  }
}
