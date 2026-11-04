import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  STAGE_SOURCE_ROOT_FILES,
  isStageSourcePath,
  stageSourceProblem,
  type StageSource,
  type StageSourceFile,
} from "../../convex/model/stageSource.ts";
import { PROJECT_DIR } from "./config.ts";

/** The source a deploy stores beside the manifest, or why it stores none this time. */
export async function readStageSource(
  root: string,
): Promise<{ source: StageSource } | { skipped: string }> {
  const files: StageSourceFile[] = [];
  for (const path of STAGE_SOURCE_ROOT_FILES) {
    if (!(await isPlainEntry(join(root, path)))) continue;
    files.push({
      path: path,
      content: await readFile(join(root, path), "utf8"),
    });
  }
  if (await isPlainEntry(join(root, PROJECT_DIR)))
    await collect(root, PROJECT_DIR, files);
  const problem = stageSourceProblem(files);
  if (problem) return { skipped: problem };
  const commitSha =
    process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_SHA : undefined;

  return {
    source: {
      files: files,
      ...(commitSha ? { commitSha: commitSha } : {}),
    },
  };
}

// Symlinks are not followed, so nothing outside the project rides along.
async function collect(
  root: string,
  dir: string,
  files: StageSourceFile[],
): Promise<void> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isStageSourcePath(`${path}/x.ts`)) await collect(root, path, files);
    } else if (entry.isFile() && isStageSourcePath(path)) {
      files.push({
        path: path,
        content: await readFile(join(root, path), "utf8"),
      });
    }
  }
}

// A link could point outside the project, at a secret; a missing entry is simply absent.
async function isPlainEntry(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((): null => null);

  return stat !== null && !stat.isSymbolicLink();
}
