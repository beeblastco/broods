import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * `broods init` and `broods dev` vendor the broods skill for coding agents
 * into repos that already work with one, and leave everything else alone:
 * no marker file means no install, and an existing install is not rewritten.
 */

const CLI = new URL("../src/cli/index.ts", import.meta.url).pathname;
const SKILL_PATH = join(".agents", "skills", "broods", "SKILL.md");
const ONBOARD_PATH = join(
  ".agents",
  "skills",
  "broods",
  "scripts",
  "onboard.sh",
);

const workdirs: string[] = [];

afterEach(async () => {
  for (const dir of workdirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function runInit(cwd: string): Promise<number> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, "init"],
    cwd: cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BROODS_BASE_URL: "http://127.0.0.1:1",
    },
  });

  return await proc.exited;
}

async function makeWorkdir(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-skill-"));
  workdirs.push(cwd);

  return cwd;
}

test("init installs the agent skill when the repo has an agent marker", async () => {
  const cwd = await makeWorkdir();
  await writeFile(join(cwd, "CLAUDE.md"), "# rules\n");

  expect(await runInit(cwd)).toBe(0);

  const skill = await readFile(join(cwd, SKILL_PATH), "utf8");
  expect(skill).toContain("name: broods");
  const onboard = await stat(join(cwd, ONBOARD_PATH));
  expect(onboard.mode & 0o111).not.toBe(0);
});

test("init skips the agent skill when no agent marker exists", async () => {
  const cwd = await makeWorkdir();

  expect(await runInit(cwd)).toBe(0);

  await expect(stat(join(cwd, SKILL_PATH))).rejects.toThrow();
});

test("init leaves an existing skill install alone", async () => {
  const cwd = await makeWorkdir();
  await writeFile(join(cwd, "CLAUDE.md"), "# rules\n");
  expect(await runInit(cwd)).toBe(0);

  await writeFile(join(cwd, SKILL_PATH), "local edits\n");
  expect(await runInit(cwd)).toBe(0);

  expect(await readFile(join(cwd, SKILL_PATH), "utf8")).toBe("local edits\n");
});

test("init refuses to write the skill through a symlink", async () => {
  const cwd = await makeWorkdir();
  const outside = await makeWorkdir();
  await writeFile(join(cwd, "CLAUDE.md"), "# rules\n");
  await mkdir(join(cwd, ".agents", "skills", "broods", "scripts"), {
    recursive: true,
  });
  await symlink(
    join(outside, "clobbered"),
    join(cwd, ".agents", "skills", "broods", "scripts", "onboard.sh"),
  );

  expect(await runInit(cwd)).toBe(0);

  await expect(stat(join(cwd, SKILL_PATH))).rejects.toThrow();
  await expect(stat(join(outside, "clobbered"))).rejects.toThrow();
});
