import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_OUTPUT_MAX_BYTES,
  type HarnessShellExecutor,
  HarnessShellProcess,
  readFileChunk,
  readHarnessStream,
} from "../src/harness/sandbox/harness-shell-process.ts";
import { SandboxOutputTooLargeError } from "../src/shared/errors.ts";

const CHUNK_BYTES = 180 * 1024;
const SLOW_KILL_MS = 1000;

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

  test("returns an abort at once while a slow kill runs on", async () => {
    const sandbox = slowKillSandbox(new Uint8Array());
    const controller = new AbortController();
    const failure = new DOMException("run stopped", "AbortError");
    const process = await HarnessShellProcess.start({
      executor: sandbox.executor,
      command: "sleep 60",
      workingDirectory: "/workspace",
      abortSignal: controller.signal,
    });
    const started = performance.now();
    setTimeout(() => controller.abort(failure), 100);

    await expect(process.collect()).rejects.toBe(failure);
    expect(performance.now() - started).toBeLessThan(SLOW_KILL_MS / 2);
    expect(sandbox.killed).toBe(false);
  });

  test("waits for a slow kill past the output cap and throws the output error", async () => {
    const sandbox = slowKillSandbox(
      new Uint8Array(HARNESS_OUTPUT_MAX_BYTES + 1).fill(120),
    );
    const process = await HarnessShellProcess.start({
      executor: sandbox.executor,
      command: "cat big.bin",
      workingDirectory: "/workspace",
      abortSignal: new AbortController().signal,
    });

    await expect(process.collect()).rejects.toBeInstanceOf(
      SandboxOutputTooLargeError,
    );
    expect(sandbox.killed).toBe(true);
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

function slowKillSandbox(stdout: Uint8Array): {
  executor: HarnessShellExecutor;
  readonly killed: boolean;
} {
  let killed = false;
  const executor: HarnessShellExecutor = {
    exec: async function (command) {
      if (command.includes("kill -TERM")) {
        await Bun.sleep(SLOW_KILL_MS);
        killed = true;

        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("echo running")) {
        return {
          exitCode: 0,
          stdout: killed ? "done 143" : "running",
          stderr: "",
        };
      }
      const offset = Number(command.match(/tail -c \+(\d+)/)?.[1] ?? 0) - 1;
      const bytes = command.includes(".stdout'") ? stdout.subarray(offset) : [];
      const encoded = offset < 0 ? "" : Buffer.from(bytes).toString("base64");

      return { exitCode: 0, stdout: `0 0 0\n${encoded}`, stderr: "" };
    },
  };

  return {
    executor: executor,
    get killed() {
      return killed;
    },
  };
}
