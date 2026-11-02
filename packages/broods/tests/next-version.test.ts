import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/next-version.ts");

let repo: string | undefined;

afterEach(async (): Promise<void> => {
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = undefined;
});

test("a breaking change on 0.x bumps the minor", async (): Promise<void> => {
  repo = await releasedRepo("0.40.0");
  await commit(repo, "0.40.0", "fix(broods)!: drop the old flag");

  expect(await run(repo)).toMatchObject({ bump: "minor", next: "0.41.0" });
});

test("a declared version ahead of the last stable tag is released as is", async (): Promise<void> => {
  repo = await releasedRepo("0.40.0");
  await commit(repo, "1.0.0", "chore(broods): cut 1.0.0");
  // A hand-pushed rc sorts above the last stable tag and must not hide it.
  git(repo, ["tag", "broods-v1.0.0-rc.1"]);

  expect(await run(repo, "--write")).toMatchObject({
    bump: "declared",
    next: "1.0.0",
  });
});

test("release candidates ship as declared and lead to the stable cut", async (): Promise<void> => {
  repo = await releasedRepo("0.43.0");

  await commit(repo, "1.0.0-rc.1", "chore(broods): cut 1.0.0-rc.1");
  expect(await run(repo, "--write")).toMatchObject({
    bump: "declared",
    next: "1.0.0-rc.1",
  });
  git(repo, ["tag", "broods-v1.0.0-rc.1"]);

  // The same commit derives the same version, so the workflow skips the publish.
  expect(await run(repo)).toMatchObject({
    bump: "declared",
    next: "1.0.0-rc.1",
  });

  await commit(repo, "1.0.0-rc.2", "fix(broods): rc feedback");
  expect(await run(repo)).toMatchObject({
    bump: "declared",
    next: "1.0.0-rc.2",
  });
  git(repo, ["tag", "broods-v1.0.0-rc.2"]);

  await commit(repo, "1.0.0", "chore(broods): cut 1.0.0");
  expect(await run(repo)).toMatchObject({ bump: "declared", next: "1.0.0" });
  git(repo, ["tag", "broods-v1.0.0"]);

  await commit(repo, "1.0.0", "feat(broods)!: drop the deprecated flag");
  expect(await run(repo)).toMatchObject({ bump: "major", next: "2.0.0" });
});

test("a stale declared version behind the tag is ignored", async (): Promise<void> => {
  repo = await releasedRepo("0.40.0");
  await commit(repo, "0.26.0", "feat(broods): add a flag");

  expect(await run(repo)).toMatchObject({ bump: "minor", next: "0.41.0" });
});

async function commit(
  dir: string,
  version: string,
  subject: string,
): Promise<void> {
  const broods = join(dir, "packages/broods");
  await mkdir(broods, { recursive: true });
  await writeFile(
    join(broods, "package.json"),
    `{\n  "name": "broods",\n  "version": "${version}"\n}\n`,
  );
  await writeFile(join(broods, "change.txt"), subject);
  await writeFile(
    join(dir, "bun.lock"),
    `{\n  "workspaces": {\n    "packages/broods": {\n      "name": "broods",\n      "version": "${version}",\n    },\n  },\n}\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", subject]);
}

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ],
    cwd: dir,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function releasedRepo(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "next-version-"));
  git(dir, ["init", "-q"]);
  await commit(dir, version, `chore(broods): release ${version}`);
  git(dir, ["tag", `broods-v${version}`]);

  return dir;
}

async function run(
  dir: string,
  ...args: string[]
): Promise<Record<string, unknown>> {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd: dir,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return JSON.parse(result.stdout.toString());
}
