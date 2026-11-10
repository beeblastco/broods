import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSource } from "../src/cli/dev-watch.ts";

// Long enough for the OS to deliver a watcher event and the 150 ms debounce to fire.
const SETTLE_MS = 400;

test("a folder renamed and renamed back during a sync syncs again", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "broods-dev-watch-"));
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "agents", "index.ts"), "export {};\n");
  let renameDuringSync = false;
  let syncs = 0;
  const watcher = watchSource(root, async (): Promise<void> => {
    syncs += 1;
    if (!renameDuringSync) return;
    renameDuringSync = false;
    // The child reads the renamed folder; the rename is undone before its sync lands.
    await rename(join(root, "agents"), join(root, "renamed"));
    await Bun.sleep(SETTLE_MS);
    await rename(join(root, "renamed"), join(root, "agents"));
    await Bun.sleep(SETTLE_MS);
  });
  try {
    await Bun.sleep(SETTLE_MS);
    const before = syncs;
    renameDuringSync = true;
    await writeFile(join(root, "agents", "index.ts"), "export const a = 1;\n");
    await Bun.sleep(SETTLE_MS * 4);

    // The stage holds the renamed folder until a second sync puts `agents/` back.
    expect(syncs - before).toBe(2);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an edit to a skill script syncs, not only .ts and .md edits", async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "broods-dev-watch-"));
  await mkdir(join(root, "skills", "s", "scripts"), { recursive: true });
  await writeFile(join(root, "skills", "s", "SKILL.md"), "# s\n");
  await writeFile(join(root, "skills", "s", "scripts", "run.py"), "print(1)\n");
  let syncs = 0;
  const watcher = watchSource(root, async (): Promise<void> => {
    syncs += 1;
  });
  try {
    await Bun.sleep(SETTLE_MS);
    const before = syncs;
    await writeFile(
      join(root, "skills", "s", "scripts", "run.py"),
      "print(2)\n",
    );
    await Bun.sleep(SETTLE_MS);

    expect(syncs - before).toBe(1);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
