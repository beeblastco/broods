import { expect, test } from "bun:test";
import {
  browserCommand,
  hasFlag,
  loginWithBrowser,
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

// A dashboard that cannot mint a code redirects with `error`; the CLI used to
// wait out its 3-minute timeout, and crashed outright with no browser launcher.
test("loginWithBrowser fails at once with the dashboard's error, browser or not", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  const dashboard = Bun.serve({
    port: 0,
    fetch: (request: Request): Response => {
      const start = new URL(request.url);
      const callback = new URL(start.searchParams.get("callback")!);
      callback.searchParams.set("state", start.searchParams.get("state")!);
      callback.searchParams.set("error", "No active org");
      setTimeout(() => void fetch(callback), 50);

      return new Response("ok");
    },
  });
  try {
    expect(loginWithBrowser(dashboard.url.origin)).rejects.toThrow(
      "Login failed: No active org",
    );
  } finally {
    await dashboard.stop(true);
    process.env.PATH = path;
  }
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
