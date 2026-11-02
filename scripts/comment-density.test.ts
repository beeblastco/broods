import { describe, expect, test } from "bun:test";
import {
  commentLines,
  judge,
  scan,
  workspaceOf,
  type Budget,
} from "./comment-density.ts";

const lines = (...source: string[]): string => source.join("\n");

describe("commentLines", () => {
  test.each([
    ["a line comment", "// why\nrun();", 1],
    ["an empty line comment", "//\n//   \nrun();", 0],
    ["a trailing comment", "run(); // why", 0],
    ["a triple-slash directive", '/// <reference types="bun" />', 1],
    ["a one-line block", "/* why */ run();", 1],
    ["a block after code", "run(); /* why */", 0],
    ["blank docstring lines", lines("/**", " * one", " *", " * two", " */"), 2],
    ["text on the opening line", lines("/** one", " * two */"), 2],
    ["a JSX comment child", lines("<div>", "  {/* why */}", "</div>"), 1],
    ["a JSX comment after a tag", "<div>{/* why */}</div>", 0],
    ["an unclosed block", lines("/* one", "two"), 2],
  ])("%s", (_, source, expected) => {
    expect(commentLines(source, true)).toBe(expected);
  });

  test("ignores comment markers inside strings and templates", () => {
    const source = lines(
      'const url = "https://example.com"; const glob = "src/**/*.ts";',
      "const script = `",
      "  // runs in the isolate",
      "  /* not ours",
      "  ${value /* ours */}",
      "`;",
      "const s = '/* still a string';",
    );
    expect(commentLines(source, false)).toBe(0);
  });

  test("ignores comment markers inside regex literals", () => {
    const source = lines(
      "const glob = /[/*]+/g; const n = a / b;",
      "// counted",
      "const close = /\\*\\//;",
    );
    expect(commentLines(source, false)).toBe(1);
  });

  test("reads JSX text as text, apostrophes and slashes included", () => {
    const source = lines(
      "const view = (",
      "  <p title='//x'>",
      "    Don't",
      "    // not a comment",
      "  </p>",
      ");",
      "// counted",
    );
    expect(commentLines(source, true)).toBe(1);
  });

  test("keeps .tsx type parameters out of JSX", () => {
    const source = lines(
      "const first = <T,>(items: T[]) => items[0];",
      "const pick = <K extends string>(key: K) => key;",
      "// counted",
    );
    expect(commentLines(source, true)).toBe(1);
  });
});

describe("scan", () => {
  test("drops whitespace and comments but keeps literals whole", () => {
    const { tokens } = scan('a  =  "x  y" /* c */ + `t ${b} u`;', false);
    expect(tokens.map((token) => token.text)).toEqual([
      "a",
      "=",
      '"x  y"',
      "+",
      "`t ${",
      "b",
      "}",
      " u`",
      ";",
    ]);
  });

  test("drops empty and blank JSX children", () => {
    const { tokens } = scan('<p>{/* c */}{" "}hi {name}</p>', true);
    expect(tokens.map((token) => token.text)).toEqual([
      "<",
      "p",
      ">",
      "{",
      "name",
      "}",
      "</p>",
    ]);
  });
});

describe("workspaceOf", () => {
  test.each([
    ["apps/core/src/index.ts", "apps/core"],
    ["packages/convex/schema.ts", "packages/convex"],
    ["scripts/local-stack.ts", "scripts"],
    ["bench/run.ts", "bench"],
    ["sst.config.ts", "(root)"],
  ])("%s", (path, expected) => {
    expect(workspaceOf(path)).toBe(expected);
  });
});

describe("judge", () => {
  const budget: Budget = {
    maxPct: 2.5,
    workspaceMaxPct: 4,
    workspaceExceptions: { "apps/lambda": { maxPct: 20, why: "vendored" } },
  };

  test("passes a codebase under both caps", () => {
    const report = judge(
      [
        { path: "apps/core/a.ts", lines: 1000, comments: 20 },
        { path: "apps/edge/b.ts", lines: 1000, comments: 30 },
      ],
      budget,
    );
    expect(report.failures).toEqual([]);
    expect(report.total.comments).toBe(50);
  });

  test("fails the total and each workspace over its cap", () => {
    const report = judge(
      [
        { path: "apps/core/a.ts", lines: 1000, comments: 10 },
        { path: "apps/edge/b.ts", lines: 1000, comments: 50 },
        { path: "apps/lambda/c.mjs", lines: 100, comments: 15 },
      ],
      budget,
    );
    expect(report.failures).toEqual([
      "total 3.57% > 2.5%: cut 24 comment lines",
      "apps/edge 5.00% > 4%: cut 11 comment lines",
    ]);
  });
});
