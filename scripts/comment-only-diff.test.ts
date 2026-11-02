import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./comment-density.ts";
import {
  compare,
  parseArgs,
  verify,
  type CodeChange,
} from "./comment-only-diff.ts";

const lines = (...source: string[]): string => source.join("\n");

describe("compare passes a comment-only edit", () => {
  test.each([
    [
      "removed comments",
      "a.ts",
      lines(
        "/**",
        " * Header.",
        " */",
        "// why",
        "export const a = 1; /* tail */",
      ),
      "export const a = 1;",
    ],
    [
      "a reflowed call",
      "a.ts",
      lines("const total = sum(", "  first, // why", "  second,", ");"),
      "const total = sum(first, second);",
    ],
    [
      "dropped return parens",
      "a.ts",
      lines(
        "function f() {",
        "  return (",
        "    a && // why",
        "    b",
        "  );",
        "}",
      ),
      "function f() {\n  return a && b;\n}",
    ],
    [
      "a joined union",
      "a.ts",
      lines("type Mode =", '  | "a" // why', '  | "b";'),
      'type Mode = "a" | "b";',
    ],
    [
      "a joined object type",
      "a.ts",
      lines("type T = {", "  a: string; // why", "  b: number;", "};"),
      "type T = { a: string; b: number };",
    ],
    [
      "a JSX comment child",
      "a.tsx",
      lines(
        "export const View = () => (",
        "  <div>",
        "    {/* why */}",
        "    <span />",
        "  </div>",
        ");",
      ),
      "export const View = () => (\n  <div>\n    <span />\n  </div>\n);",
    ],
    [
      "a shorter suppression reason",
      "a.ts",
      "// oxlint-disable-next-line no-console -- prints the long reason here\nconsole.log(1);",
      "// oxlint-disable-next-line no-console -- why\nconsole.log(1);",
    ],
  ])("%s", (_, path, before, after) => {
    expect(compare(path, before, after)).toEqual({ kind: "comment-only" });
  });
});

describe("compare reports a code change", () => {
  test.each<[string, string, string, string, CodeChange["kind"]]>([
    [
      "an operator",
      "a.ts",
      "export const f = (a: number) => a + 1;",
      "export const f = (a: number) => a - 1;",
      "runtime",
    ],
    [
      "text in a string that looks like a comment",
      "a.ts",
      'export const s = "// one";',
      'export const s = "// two";',
      "runtime",
    ],
    [
      "a comment-looking line in a template",
      "a.ts",
      "export const s = `\n// sent as is\n`;",
      "export const s = `\n`;",
      "runtime",
    ],
    [
      "a regex",
      "a.ts",
      "export const r = /\\/\\/ a/;",
      "export const r = /\\/\\/ b/;",
      "runtime",
    ],
    [
      "JSX text",
      "a.tsx",
      "export const V = () => <p>one</p>;",
      "export const V = () => <p>two</p>;",
      "runtime",
    ],
    [
      "code that no longer parses",
      "a.ts",
      "export const a = 1;",
      "export const a = ;",
      "runtime",
    ],
    [
      "dead code",
      "a.ts",
      "if (false) {\n  run(1);\n}",
      "if (false) {\n  run(2);\n}",
      "runtime",
    ],
    [
      "a type annotation",
      "a.ts",
      "export let a: string;",
      "export let a: number;",
      "types",
    ],
    [
      "an interface member",
      "a.ts",
      "interface A {\n  a: string;\n  b?: number;\n}",
      "interface A {\n  a: string;\n}",
      "types",
    ],
    [
      "a removed @ts-expect-error",
      "a.ts",
      "// @ts-expect-error untyped\nrun();",
      "run();",
      "types",
    ],
    [
      "a removed pure annotation",
      "a.ts",
      "export const a = /* @__PURE__ */ make();",
      "export const a = make();",
      "types",
    ],
    [
      "a removed lint rule",
      "a.ts",
      "// oxlint-disable-next-line a, b -- why\nrun();",
      "// oxlint-disable-next-line a -- why\nrun();",
      "types",
    ],
  ])("%s", (_, path, before, after, kind) => {
    expect(compare(path, before, after).kind).toBe(kind);
  });

  test("points at the first changed token", () => {
    expect(
      compare("a.ts", "let a: string;", "// note\nlet a: number;"),
    ).toEqual({
      kind: "types",
      where: 'line 1 "string" -> line 2 "number"',
    });
  });
});

describe("parseArgs", () => {
  test("reads a base and the allowed files", () => {
    const args = parseArgs(["--allow", "./a.ts", "b.ts", "--base", "dev"]);
    expect(args.base).toBe("dev");
    expect([...args.allow]).toEqual(["a.ts", "b.ts"]);
  });

  test.each([[["--base"]], [["--nope"]], [["a.ts"]]])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow("unknown argument");
  });
});

describe("verify", () => {
  const root = mkdtempSync(join(tmpdir(), "comment-only-diff-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, source: string): void =>
    writeFileSync(join(root, path), source);
  const run = (...args: string[]) =>
    Bun.spawnSync(
      ["bun", join(import.meta.dir, "comment-only-diff.ts"), ...args],
      {
        cwd: root,
      },
    );

  git(["init", "-q"], root);
  write("comment.ts", "// old\nexport const a = 1;\n");
  write("code.ts", "export const b = 1;\n");
  write("refactor.tsx", "export const C = () => <p>a</p>;\n");
  write("gone.ts", "export const d = 1;\n");
  write("notes.md", "old\n");
  git(["add", "."], root);
  git(
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "base",
    ],
    root,
  );
  write("comment.ts", "export const a = 1;\n");
  write("code.ts", "export const b = 2;\n");
  write("refactor.tsx", "export const C = () => <p>b</p>;\n");
  write("notes.md", "new\n");
  write("staged.ts", "export const e = 1;\n");
  git(["add", "staged.ts", "code.ts"], root);
  write("untracked.ts", "export const f = 1;\n");
  unlinkSync(join(root, "gone.ts"));

  test("sorts staged, unstaged, added and deleted files", () => {
    const result = verify(root, "HEAD", new Set(["refactor.tsx"]));
    expect(result.commentOnly).toEqual(["comment.ts"]);
    expect(result.changed.map((entry) => [entry.path, entry.kind])).toEqual([
      ["code.ts", "runtime"],
    ]);
    expect(result.allowed.map((entry) => entry.path)).toEqual(["refactor.tsx"]);
    expect(result.deleted).toEqual(["gone.ts"]);
    expect(result.added.toSorted()).toEqual(["staged.ts", "untracked.ts"]);
  });

  test("exits 1 on a code change and 0 once it is allowed", () => {
    const failed = run("--base", "HEAD", "--allow", "refactor.tsx");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.toString()).toContain(
      "code changed (1):\n  code.ts: runtime",
    );
    expect(
      run("--base", "HEAD", "--allow", "refactor.tsx", "code.ts").exitCode,
    ).toBe(0);
  });

  test("exits 2 on an unknown base", () => {
    expect(run("--base", "no-such-ref").exitCode).toBe(2);
  });
});
