import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Renames ship no compatibility shim. A project still carrying `--env` or
 * BROODS_ENVIRONMENT used to resolve to Development and act on a stage the user
 * never named, which is the one failure the hard break exists to prevent; a
 * dropped command name has to say where it went rather than land on the
 * unknown-command page.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;

const workdirs: string[] = [];

afterEach(async () => {
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function projectDir(envLocal: string[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-hard-break-"));
  workdirs.push(cwd);
  await writeFile(join(cwd, ".env.local"), `${envLocal.join("\n")}\n`, "utf8");

  return cwd;
}

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Minimal env: the runner's own BROODS_* vars would shadow `.env.local`.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_TOKEN: "tok",
      BROODS_BASE_URL: "http://127.0.0.1:1",
    },
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  return { exitCode: exitCode, stderr: stderr };
}

test("rejects the pre-rename status command", async () => {
  const cwd = await projectDir(['BROODS_PROJECT="demo-app"']);

  const result = await runCli(cwd, ["status"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("status was renamed to whoami");
});

test("rejects the pre-rename --env flag", async () => {
  const cwd = await projectDir(['BROODS_PROJECT="demo-app"']);

  const result = await runCli(cwd, ["dev", "--env", "production"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--env was renamed to --stage");
});

test("rejects a project still carrying BROODS_ENVIRONMENT", async () => {
  const cwd = await projectDir([
    'BROODS_PROJECT="demo-app"',
    'BROODS_ENVIRONMENT="production"',
  ]);

  const result = await runCli(cwd, ["whoami"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("BROODS_ENVIRONMENT was renamed");
  expect(result.stderr).toContain("production");
});

// BROODS_STAGE is the whole migration, so a project that has already been
// migrated must not trip the guard just because the old key lingers.
test("allows BROODS_ENVIRONMENT alongside an explicit BROODS_STAGE", async () => {
  const cwd = await projectDir([
    'BROODS_PROJECT="demo-app"',
    'BROODS_ENVIRONMENT="production"',
    'BROODS_STAGE="staging"',
  ]);

  const result = await runCli(cwd, ["whoami"]);

  expect(result.stderr).not.toContain("BROODS_ENVIRONMENT was renamed");
});
