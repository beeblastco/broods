import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Help is progressive: the bare command lists groups, and every command owns a
 * page. A grouped command with no subcommand must print that page rather than
 * guess a default and reach the network.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;

const workdirs: string[] = [];

afterEach(async () => {
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-help-"));
  workdirs.push(cwd);
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    // An unreachable base URL: a help path that still called out would hang.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_TOKEN: "tok",
      BROODS_BASE_URL: "http://127.0.0.1:1",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}

test("the bare CLI lists commands and points at per-command help", async () => {
  const result = await runCli([]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: broods <command>");
  expect(result.stdout).toContain("Run `broods <command> --help`");
  // Subcommands belong to the command's own page, not the top-level list.
  expect(result.stdout).not.toContain("org create");
});

test.each(["org", "stage", "env", "agent"])(
  "`broods %s` prints its own page instead of running a default",
  async (command) => {
    const result = await runCli([command]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Usage: broods ${command} <`);
    expect(result.stdout).toContain("Global options:");
  },
);

test.each(["deploy", "dev", "logs", "run", "update", "whoami"])(
  "`broods %s --help` prints its page without reaching the network",
  async (command) => {
    const result = await runCli([command, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Usage: broods ${command}`);
  },
);

test("an unknown subcommand names it and prints the command's page", async () => {
  const result = await runCli(["org", "bogus"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Unknown org subcommand: bogus");
  expect(result.stderr).toContain("Usage: broods org <list|use|create>");
});
