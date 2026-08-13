import { expect, test } from "bun:test";
import { optionValue, positionalArgs } from "../src/cli/utils.ts";

// `--stage` has to be a known value option, or its value falls through to
// positionalArgs and `broods run <agent>` sends the stage name as the prompt.
test("positionalArgs drops --stage and the name it carries", () => {
  const args = ["helper", "--stage", "staging", "say hi"];

  expect(positionalArgs(args)).toEqual(["helper", "say hi"]);
});

test("positionalArgs drops --from and the stage it clones", () => {
  expect(positionalArgs(["staging", "--from", "development"])).toEqual([
    "staging",
  ]);
});

test("optionValue reads the stage override", () => {
  expect(optionValue(["--stage", "staging"], "--stage")).toBe("staging");
  expect(optionValue(["--stage", "staging"], "--env")).toBeUndefined();
});
