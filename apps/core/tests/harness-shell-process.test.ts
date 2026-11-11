import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_OUTPUT_MAX_BYTES,
  type HarnessShellExecutor,
  readFileChunk,
  readHarnessStream,
} from "../src/harness/sandbox/harness-shell-process.ts";
import { SandboxOutputTooLargeError } from "../src/shared/errors.ts";

const CHUNK_BYTES = 180 * 1024;

const bash: HarnessShellExecutor = {
  exec: async function (command) {
    const run = Bun.spawnSync(["bash", "-c", command]);

    return {
      exitCode: run.exitCode,
      stdout: run.stdout.toString(),
      stderr: run.stderr.toString(),
    };
  },
};

describe("harness shell process", () => {
  test("fails past the output cap holding at most the cap plus one chunk", async () => {
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: function (controller) {
          produced += CHUNK_BYTES;
          controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(120));
        },
        cancel: function () {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const read = readHarnessStream(stream, "stdout");

    await expect(read).rejects.toBeInstanceOf(SandboxOutputTooLargeError);
    expect(produced).toBeLessThanOrEqual(
      HARNESS_OUTPUT_MAX_BYTES + CHUNK_BYTES,
    );
    expect(cancelled).toBe(true);
  });

  test("stamps a symlinked file with the size of the file it points to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-shell-"));
    try {
      await writeFile(join(dir, "target.bin"), new Uint8Array(1024 * 1024));
      await symlink(join(dir, "target.bin"), join(dir, "link.bin"));

      const chunk = await readFileChunk(bash, join(dir, "link.bin"), 0);

      expect(chunk?.stamp.split(" ")[0]).toBe(String(1024 * 1024));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
