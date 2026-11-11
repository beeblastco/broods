import { describe, expect, test } from "bun:test";
import {
  falsePositiveRule,
  median,
  parseArgs,
  poll,
  renderComment,
  renderDiagnosis,
  score,
  workspaceOf,
  type Candidate,
  type Generation,
  type Judge,
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

  test("a SyntaxError the changed code throws is not the test runner's fault", () => {
    expect(
      falsePositiveRule(
        "expect(parse(render(rows))).toEqual(rows);",
        "SyntaxError: JSON Parse error: Unexpected identifier",
      ),
    ).toBeUndefined();
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

describe("poll", () => {
  const judges: Judge[] = ["first", "second", "third"].map((model) => ({
    model: model,
    effort: "medium",
  }));
  const asked = async (
    ...likelihoods: (Verdict["likelihood"] | undefined)[]
  ): Promise<string[]> => {
    const models: string[] = [];
    await poll(judges, (judge) => {
      models.push(judge.model);
      const likelihood = likelihoods[models.length - 1];

      return Promise.resolve(
        likelihood === undefined
          ? undefined
          : { ...verdict(likelihood), duplicate: false },
      );
    });

    return models;
  };

  test("two judges that agree settle it, the third is never asked", async () => {
    expect(await asked("high", "high")).toEqual(["first", "second"]);
    expect(await asked("low", "low")).toEqual(["first", "second"]);
  });

  test("a split vote or an abstention asks the next judge", async () => {
    expect(await asked("high", "low", "high")).toHaveLength(3);
    expect(await asked("high", undefined, "high")).toHaveLength(3);
  });

  test("a duplicate stops the poll with no vote", async () => {
    const polled = await poll(judges, () =>
      Promise.resolve({ ...verdict("high"), duplicate: true }),
    );
    expect(polled).toEqual({ verdicts: [], duplicate: true });
  });
});

describe("renderComment", () => {
  test("asks about a catch that scored high enough", () => {
    const comment = renderComment(generation, [
      candidate(votes("high", "high", "medium")),
    ]);
    expect(comment?.startsWith("<!-- jittest -->")).toBe(true);
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

test("renderDiagnosis names the commit whose parent passes the reproduction", () => {
  const comment = renderDiagnosis(
    "blocked() compares with > instead of >=.",
    [
      {
        file: "apps/gateway/tests/jittest/blocked.test.ts",
        behavior: "A key at the limit is blocked.",
        suspects: ["apps/gateway/src/rate-limiter.ts"],
        outcome: "reproduced",
        rule: undefined,
        code: "expect(limiter.blocked(key)).toBe(true);",
        output: "Expected: true",
        culprit: "abc1234 refactor the limiter",
        checked: 2,
      },
      {
        file: "apps/gateway/tests/jittest/expiry.test.ts",
        behavior: "An expired window is not blocked.",
        suspects: ["apps/gateway/src/rate-limiter.ts"],
        outcome: "reproduced",
        rule: undefined,
        code: "expect(limiter.blocked(key)).toBe(false);",
        output: "Expected: false",
        culprit: undefined,
        checked: 1,
      },
    ],
    "0123456789abcdef",
  );
  expect(comment).toContain("reproduced on 01234567");
  expect(comment).toContain("Broken by abc1234 refactor the limiter");
  expect(comment).toContain("No culprit among the 1 commit(s) checked");
  expect(renderDiagnosis("No unit test can show it.", [], "0123")).toContain(
    "not reproduced",
  );
});

test("workspaceOf maps a path to a workspace it can run tests in", () => {
  expect(workspaceOf("apps/core/src/run.ts")).toBe("apps/core");
  expect(workspaceOf("apps/dashboard/app/page.tsx")).toBeUndefined();
});

test("parseArgs treats an empty title from a manual CI run as unset", () => {
  process.env.JITTEST_TITLE = "";
  try {
    expect(parseArgs([]).title).toBeUndefined();
  } finally {
    delete process.env.JITTEST_TITLE;
  }
});

test("parseArgs rejects an unknown flag", () => {
  expect(parseArgs(["--base", "origin/dev"]).base).toBe("origin/dev");
  expect(() => parseArgs(["--nope", "x"])).toThrow("unknown argument");
});
