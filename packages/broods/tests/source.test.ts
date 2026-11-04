import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStageSource } from "../src/source.ts";

let root = "";

afterEach(async (): Promise<void> => {
  await rm(root, { recursive: true, force: true });
});

describe("readStageSource", () => {
  test("reads broods/ text and the root manifests, skipping secrets, builds and links", async () => {
    root = await mkdtemp(join(tmpdir(), "broods-source-"));
    await mkdir(join(root, "broods", "_generated"), { recursive: true });
    await mkdir(join(root, "broods", "tools"));
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, ".env.local"), "SECRET=1");
    await writeFile(join(root, "broods", "index.ts"), "export {};");
    await writeFile(join(root, "broods", "tools", "a.md"), "# a");
    await writeFile(join(root, "broods", ".env"), "SECRET=1");
    await writeFile(join(root, "broods", "_generated", "ids.ts"), "x");
    await symlink(join(root, ".env.local"), join(root, "broods", "linked.ts"));

    const read = await readStageSource(root);

    expect(
      "source" in read && read.source.files.map((file) => file.path).sort(),
    ).toEqual(["broods/index.ts", "broods/tools/a.md", "package.json"]);
  });
});
