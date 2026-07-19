import { rm } from "node:fs/promises";
import { join } from "node:path";

const roots = ["../../apps/core/src/shared", "../convex"];

for (const root of roots) {
  const files = new Bun.Glob("**/*.{js,d.ts}").scanSync({
    cwd: root,
    absolute: false,
  });
  for (const file of files) {
    const path = join(root, file);
    if (isGitTracked(path)) continue;
    await rm(path, { force: true });
  }
}

function isGitTracked(path: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "--error-unmatch", path],
    stdout: "ignore",
    stderr: "ignore",
  });

  return result.exitCode === 0;
}
