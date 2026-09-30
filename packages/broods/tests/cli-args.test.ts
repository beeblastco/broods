import { expect, test } from "bun:test";
import {
  browserCommand,
  hasFlag,
  optionValue,
  positionalArgs,
} from "../src/cli/utils.ts";

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

test("positionalArgs keeps the token after an inline --stage=value", () => {
  expect(positionalArgs(["helper", "--stage=staging", "say hi"])).toEqual([
    "helper",
    "say hi",
  ]);
});

test("optionValue reads the stage override", () => {
  expect(optionValue(["--stage", "staging"], "--stage")).toBe("staging");
  expect(optionValue(["--stage", "staging"], "--env")).toBeUndefined();
});

// `broods deploy --stage=staging` used to miss the override and deploy production.
test("optionValue reads an inline --name=value", () => {
  expect(optionValue(["--stage=staging"], "--stage")).toBe("staging");
  expect(optionValue(["--base-url=http://x/?a=b"], "--base-url")).toBe(
    "http://x/?a=b",
  );
  expect(optionValue(["--stages=x"], "--stage")).toBeUndefined();
  expect(optionValue(["--level="], "--level")).toBeUndefined();
});

test("hasFlag reads a value option inline and a boolean flag only bare", () => {
  expect(hasFlag(["--sandbox=abc"], "--sandbox")).toBe(true);
  expect(hasFlag(["--force"], "--force")).toBe(true);
  expect(hasFlag(["--forced"], "--force")).toBe(false);
});

// `broods project delete x --yes=false` must still ask before deleting.
test("hasFlag ignores a boolean flag given a value", () => {
  expect(hasFlag(["--yes=false"], "--yes")).toBe(false);
  expect(hasFlag(["--prune=false"], "--prune")).toBe(false);
});

// `cmd /c start` cut the login URL at its first `&`, dropping the PKCE challenge.
test("browserCommand hands Windows the whole URL", () => {
  const url = "https://dash/cli-auth/start?callback=x&state=y";

  expect(browserCommand(url, "win32")).toEqual({
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", url],
  });
  expect(browserCommand(url, "darwin")).toEqual({
    command: "open",
    args: [url],
  });
});
