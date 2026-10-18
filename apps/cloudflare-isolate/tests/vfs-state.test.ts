/**
 * The disk codec on its own, under Bun: what a command wrote survives a
 * round trip, and nothing else is stored.
 */

import { expect, it } from "bun:test";
import { Bash } from "just-bash/browser";
import { decodeState, emptyFs, encodeState } from "../src/vfs-state.ts";

it("stores nothing for a disk no command touched", async (): Promise<void> => {
  expect(await encodeState(emptyFs())).toBeNull();
});

it("round-trips files, their modes, empty directories and symlinks", async (): Promise<void> => {
  const fs = emptyFs();
  const bash = new Bash({ fs: fs, cwd: "/workspace" });
  await bash.exec(
    "mkdir -p /workspace/empty /workspace/src && printf 'hi' > /workspace/src/a.txt && chmod 600 /workspace/src/a.txt && ln -s src/a.txt /workspace/link",
  );
  await fs.writeFile("/workspace/bin.dat", new Uint8Array([0, 0xff]));

  const restored = await decodeState((await encodeState(fs))!);

  expect(await restored.readFile("/workspace/src/a.txt")).toBe("hi");
  expect((await restored.stat("/workspace/src/a.txt")).mode & 0o777).toBe(
    0o600,
  );
  expect((await restored.stat("/workspace/empty")).isDirectory).toBe(true);
  expect(await restored.readlink("/workspace/link")).toBe("src/a.txt");
  expect(await restored.readFile("/workspace/link")).toBe("hi");
  expect([...(await restored.readFileBuffer("/workspace/bin.dat"))]).toEqual([
    0, 0xff,
  ]);
  expect(await encodeState(restored)).toEqual(await encodeState(fs));
});

it("goes back to nothing once every file is removed", async (): Promise<void> => {
  const fs = emptyFs();
  const bash = new Bash({ fs: fs, cwd: "/workspace" });
  await bash.exec(
    "echo x > /workspace/x && rm /workspace/x && rmdir /workspace",
  );

  expect(await encodeState(fs)).toBeNull();
});
