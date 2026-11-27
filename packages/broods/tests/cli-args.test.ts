import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserCommand,
  hasFlag,
  loginWithBrowser,
  optionValue,
  positionalArgs,
} from "../src/cli/utils.ts";

test("positionalArgs drops --stage and the name it carries", (): void => {
  const args = ["helper", "--stage", "staging", "say hi"];

  expect(positionalArgs(args)).toEqual(["helper", "say hi"]);
});

test("positionalArgs keeps the token after an inline --stage=value", (): void => {
  expect(positionalArgs(["helper", "--stage=staging", "say hi"])).toEqual([
    "helper",
    "say hi",
  ]);
});

test("optionValue reads the stage override", (): void => {
  expect(optionValue(["--stage", "staging"], "--stage")).toBe("staging");
  expect(optionValue(["--stage", "staging"], "--env")).toBeUndefined();
});

test("optionValue reads an inline --name=value", (): void => {
  expect(optionValue(["--stage=staging"], "--stage")).toBe("staging");
  expect(optionValue(["--base-url=http://x/?a=b"], "--base-url")).toBe(
    "http://x/?a=b",
  );
  expect(optionValue(["--stages=x"], "--stage")).toBeUndefined();
  expect(optionValue(["--level="], "--level")).toBeUndefined();
});

test("hasFlag reads a value option inline and a boolean flag only bare", (): void => {
  expect(hasFlag(["--sandbox=abc"], "--sandbox")).toBe(true);
  expect(hasFlag(["--force"], "--force")).toBe(true);
  expect(hasFlag(["--forced"], "--force")).toBe(false);
});

test("hasFlag ignores a boolean flag given a value", (): void => {
  expect(hasFlag(["--yes=false"], "--yes")).toBe(false);
  expect(hasFlag(["--prune=false"], "--prune")).toBe(false);
});

test("broods login collects the login once it is approved, with no callback to this machine", async (): Promise<void> => {
  const home = mkdtempSync(join(tmpdir(), "broods-login-"));
  let polls = 0;
  let verifier = "";
  const server = Bun.serve({
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      if (new URL(request.url).pathname === "/cli-auth/config") {
        return Response.json({ base_url: server.url.origin });
      }
      polls += 1;
      verifier = ((await request.json()) as { code_verifier: string })
        .code_verifier;

      return polls < 2
        ? Response.json({ pending: true }, { status: 202 })
        : Response.json({ token: "bcli_test" });
    },
  });
  try {
    // A subprocess: the stored-login path is fixed from HOME when the CLI loads.
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        new URL("../src/cli/index.ts", import.meta.url).pathname,
        "login",
        "--dashboard-url",
        server.url.origin,
      ],
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/nonexistent", HOME: home },
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    const link = new URL(stdout.match(/^ {2}(http\S+)$/m)![1]!);

    expect(exitCode).toBe(0);
    expect(polls).toBe(2);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.pathname).toBe("/cli-auth/start");
    expect(link.searchParams.has("callback")).toBe(false);
    expect(stdout).toContain(`Your code is ${link.searchParams.get("code")}`);
    expect(
      readFileSync(join(home, ".broods", "config.json"), "utf8"),
    ).toContain("bcli_test");
  } finally {
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
});

test("loginWithBrowser stops with the server's reason when the login is refused", async (): Promise<void> => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  const server = Bun.serve({
    port: 0,
    fetch: (request: Request): Response =>
      new URL(request.url).pathname === "/cli-auth/config"
        ? Response.json({ base_url: server.url.origin })
        : new Response("Login code is invalid or expired", { status: 400 }),
  });
  try {
    await expect(loginWithBrowser(server.url.origin)).rejects.toThrow(
      "Login failed: 400 Login code is invalid or expired",
    );
  } finally {
    await server.stop(true);
    process.env.PATH = path;
  }
});

test("browserCommand hands Windows the whole URL", (): void => {
  const url = "https://dash/cli-auth/start?code_challenge=x&code=y";

  expect(browserCommand(url, "win32")).toEqual({
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", url],
  });
  expect(browserCommand(url, "darwin")).toEqual({
    command: "open",
    args: [url],
  });
});
