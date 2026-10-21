/**
 * The disk codec on its own, under Bun: what a command wrote survives a
 * round trip, nothing else is stored, and a read leaves the packed disk equal.
 */

import { expect, it } from "bun:test";
import { Bash } from "just-bash/browser";
import {
  compressState,
  decodeState,
  emptyFs,
  packState,
  samePacked,
} from "../src/vfs-state.ts";

it("stores nothing for a disk no command touched, its empty working directory included", async (): Promise<void> => {
  expect(await packState(emptyFs(), "/workspace")).toBeNull();
  const fs = emptyFs();
  await fs.mkdir("/workspace", { recursive: true });
  expect(await packState(fs, "/workspace")).toBeNull();
  await fs.mkdir("/workspace/src", { recursive: true });
  expect(await packState(fs, "/workspace")).not.toBeNull();
});

it("round-trips files, their modes, empty directories and symlinks", async (): Promise<void> => {
  const fs = emptyFs();
  const bash = new Bash({ fs: fs, cwd: "/workspace" });
  await bash.exec(
    "mkdir -p /workspace/empty /workspace/src && printf 'hi' > /workspace/src/a.txt && chmod 600 /workspace/src/a.txt && ln -s src/a.txt /workspace/link",
  );
  await fs.writeFile("/workspace/bin.dat", new Uint8Array([0, 0xff, 10]));

  const packed = (await packState(fs, "/workspace"))!;
  const restored = await decodeState(compressState(packed));

  expect(await restored.fs.readFile("/workspace/src/a.txt")).toBe("hi");
  expect((await restored.fs.stat("/workspace/src/a.txt")).mode & 0o777).toBe(
    0o600,
  );
  expect((await restored.fs.stat("/workspace/empty")).isDirectory).toBe(true);
  expect(await restored.fs.readlink("/workspace/link")).toBe("src/a.txt");
  expect(await restored.fs.readFile("/workspace/link")).toBe("hi");
  expect([...(await restored.fs.readFileBuffer("/workspace/bin.dat"))]).toEqual(
    [0, 0xff, 10],
  );
  expect(
    samePacked(restored.packed, await packState(restored.fs, "/workspace")),
  ).toBe(true);
  expect(samePacked(packed, restored.packed)).toBe(true);
});

it("tells a read from a write by the packed bytes", async (): Promise<void> => {
  const fs = emptyFs();
  const bash = new Bash({ fs: fs, cwd: "/workspace" });
  await bash.exec("echo x > /workspace/x");
  const written = await packState(fs, "/workspace");
  await bash.exec("cat /workspace/x");

  expect(samePacked(written, await packState(fs, "/workspace"))).toBe(true);
  await bash.exec("rm /workspace/x && rmdir /workspace");
  expect(await packState(fs, "/workspace")).toBeNull();
  expect(samePacked(written, null)).toBe(false);
  expect(samePacked(null, null)).toBe(true);
});
