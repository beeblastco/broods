import { readFileSync } from "node:fs";
import {
  parseSync,
  Visitor,
  type JSXChild,
  type JSXElement,
  type JSXFragment,
} from "oxc-parser";
import { git, SOURCE_FILE } from "./comment-density.ts";

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

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Span {
  start: number;
  end: number;
}

// ASTs without positions or parens decide; Bun's output only labels a change runtime or types.
export function compare(path: string, before: string, after: string): Verdict {
  const old = parse(path, before);
  const now = parse(path, after);
  const errors = [...old.errors, ...now.errors];
  if (errors.length > 0) {
    return { kind: "runtime", where: `does not parse: ${errors.join("; ")}` };
  }
  const file = (source: string): Span => ({ start: 0, end: source.length });
  const spans = locate(old.tree, now.tree, [file(before), file(after)]);
  if (spans === undefined) return { kind: "comment-only" };
  const where = `${side(before, spans[0])} -> ${side(after, spans[1])}`;
  const runtime = transpile(path, before) !== transpile(path, after);

  return { kind: runtime ? "runtime" : "types", where: where };
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

const clip = (text: string): string =>
  JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);

// React's JSX whitespace rule: edge line breaks drop, inner ones become a space.
function cleanChildren(node: JSXElement | JSXFragment): void {
  node.children = node.children.flatMap((child): JSXChild[] => {
    if (child.type === "JSXExpressionContainer") {
      return child.expression.type === "JSXEmptyExpression" ? [] : [child];
    }
    if (child.type !== "JSXText") return [child];
    const value = child.value
      .replace(/^[ \t]*(?:\r?\n[ \t]*)+|(?:[ \t]*\r?\n)+[ \t]*$/g, "")
      .replace(/[ \t]*(?:\r?\n[ \t]*)+/g, " ");

    return value === "" ? [] : [{ ...child, value: value, raw: null }];
  });
}

function loaderOf(path: string): Bun.JavaScriptLoader {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";

  return /\.[cm]?ts$/.test(path) ? "ts" : "js";
}

// The innermost node on each side that holds the first difference, start and end ignored.
function locate(
  before: Json,
  after: Json,
  at: [Span, Span],
): [Span, Span] | undefined {
  const here: [Span, Span] = [spanOf(before) ?? at[0], spanOf(after) ?? at[1]];
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object"
  ) {
    return before === after ? undefined : here;
  }
  const left = new Map(Object.entries(before));
  const right = new Map(Object.entries(after));
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    if (key === "start" || key === "end") continue;
    const found = locate(left.get(key) ?? null, right.get(key) ?? null, here);
    if (found !== undefined) return found;
  }

  return left.size === right.size ? undefined : here;
}

// Directives join the tree keyed by how many nodes start before them, so a move is a change.
function parse(path: string, source: string): { tree: Json; errors: string[] } {
  const parsed = parseSync(path, source, { preserveParens: false });
  new Visitor({
    JSXElement: cleanChildren,
    JSXFragment: cleanChildren,
  }).visit(parsed.program);
  const starts: number[] = [];
  const json = JSON.stringify(parsed.program, (key, value: unknown) => {
    if (key === "start" && typeof value === "number") starts.push(value);

    return typeof value === "bigint" ? String(value) : value;
  });
  const directives = parsed.comments.flatMap(({ start, end }) => {
    const text = source.slice(start, end);
    const found = /^\/\/\/\s*<(?:reference|amd)/.test(text)
      ? [text.trim()]
      : [...text.matchAll(DIRECTIVE)].map((match) => match[0]);
    const after = starts.filter((at) => at < start).length;

    return found.length === 0
      ? []
      : [{ text: found.join(" "), after: after, start: start, end: end }];
  });

  return {
    tree: [JSON.parse(json), ...directives],
    errors: parsed.errors.map((error) => error.message),
  };
}

const side = (source: string, span: Span): string =>
  `line ${source.slice(0, span.start).split("\n").length} ${clip(source.slice(span.start, span.end))}`;

const spanOf = (node: Json): Span | undefined =>
  typeof node === "object" &&
  node !== null &&
  !Array.isArray(node) &&
  typeof node.start === "number" &&
  typeof node.end === "number"
    ? { start: node.start, end: node.end }
    : undefined;

function transpile(path: string, source: string): string {
  const loader = loaderOf(path);

  return new Bun.Transpiler({
    loader: loader,
    deadCodeElimination: false,
  }).transformSync(source);
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
