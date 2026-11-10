import { describe, expect, test } from "bun:test";
import {
  falsePositiveRule,
  median,
  parseArgs,
  renderComment,
  score,
  workspaceOf,
  type Candidate,
  type Generation,
  type Verdict,
} from "./jittest.ts";

const verdict = (likelihood: Verdict["likelihood"]): Verdict => ({
  model: "judge",
  likelihood: likelihood,
  change: "limit() used to cap at 10, now returns every row.",
  unexpected: "The change only renames a helper.",
});

const votes = (...likelihoods: Verdict["likelihood"][]): Verdict[] =>
  likelihoods.map(verdict);

const generation: Generation = {
  intent: "Rename a helper.",
  kind: "refactor",
  risks: ["the cap is lost"],
  tests: [],
};

const candidate = (verdicts: Verdict[], rule?: string): Candidate => ({
  file: "apps/core/tests/jittest/limit.test.ts",
  workflow: "intent-aware",
  risk: "the cap is lost",
  behavior: "limit() caps at 10.",
  outcome: "weak-catch",
  code: "expect(limit(rows)).toHaveLength(10);",
  output: "Expected length: 10\nReceived length: 12",
  assessment: {
    rule: rule,
    pattern: "refactor",
    verdicts: verdicts,
    score: score(rule, "refactor", verdicts),
  },
});

describe("falsePositiveRule", () => {
  test.each([
    ["broken_test_runner", "", "error: Cannot find module '../src/gone.ts'"],
    ["type_mismatch", "", "TypeError: store.read is not a function"],
    ["not_implemented_exception", "", "Error: Not implemented"],
    ["web_server_down", "", "ConnectionRefused: Unable to connect"],
    ["reflection", "const inner = (store as any).rows;", "expected 1"],
    ["mock_broken", 'mock.module("../src/db.ts", () => ({}));', "expected 1"],
    [
      "expecting_particular_calls_to_functions",
      "expect(save).toHaveBeenCalledTimes(2);",
      "expected 2",
    ],
  ])("%s", (name, code, output) => {
    expect(falsePositiveRule(code, output)).toBe(name);
  });

  test("an assertion on a return value matches no rule", () => {
    expect(
      falsePositiveRule(
        "expect(limit(rows)).toHaveLength(10);",
        "Expected length: 10\nReceived length: 12",
      ),
    ).toBeUndefined();
  });
});

describe("score", () => {
  test("the median vote decides, so one outlier judge does not", () => {
    expect(median([1, -1, 1])).toBe(1);
    expect(score(undefined, undefined, votes("high", "low", "high"))).toBe(1);
    expect(score(undefined, undefined, votes("low", "high", "low"))).toBe(-1);
  });

  test("a true-positive pattern lifts a split vote over the report line", () => {
    const split = votes("high", "medium", "low");
    expect(score(undefined, undefined, split)).toBe(0);
    expect(score(undefined, "refactor", split)).toBe(0.5);
  });

  test("a false-positive rule overrides the judges", () => {
    expect(score("reflection", "refactor", votes("high", "high"))).toBe(-1);
  });
});

describe("renderComment", () => {
  test("asks about a catch that scored high enough", () => {
    const comment = renderComment(generation, [
      candidate(votes("high", "high", "medium")),
    ]);
    expect(comment).toContain("1 behavior change(s) to confirm");
    expect(comment).toContain(
      "**limit() used to cap at 10, now returns every row. Is that expected?**",
    );
  });

  test("stays silent when every catch is filtered", () => {
    expect(
      renderComment(generation, [
        candidate(votes("low", "low", "low")),
        candidate(votes("high", "high", "high"), "reflection"),
        { ...candidate([]), outcome: "passes", assessment: undefined },
      ]),
    ).toBeUndefined();
  });
});

test("workspaceOf maps a path to a workspace it can run tests in", () => {
  expect(workspaceOf("apps/core/src/run.ts")).toBe("apps/core");
  expect(workspaceOf("apps/dashboard/app/page.tsx")).toBeUndefined();
});

test("parseArgs rejects an unknown flag", () => {
  expect(parseArgs(["--base", "origin/dev"]).base).toBe("origin/dev");
  expect(() => parseArgs(["--nope", "x"])).toThrow("unknown argument");
});
