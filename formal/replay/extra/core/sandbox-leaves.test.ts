import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  generateJobId,
  logsScript,
  stopScript,
} from "../../../../apps/core/src/harness/sandbox/jobs.ts";
import {
  HarnessShellProcess,
  readFileChunk,
  readHarnessStream,
} from "../../../../apps/core/src/harness/sandbox/harness-shell-process.ts";
import { withImageLimits } from "../../../../apps/core/src/harness/tools/utils.ts";

type ShellResult = { exitCode: number; stdout: string; stderr: string };
type ImagePart = { type: "image-data"; data: string; mediaType: string };

const SWEEP_INTERVAL_ENV = "SANDBOX_SWEEP_INTERVAL_SECONDS";
const query = mock(async (name: string): Promise<unknown> =>
  name === "listOrphanedSandboxInstances"
    ? { page: [], cursor: null, isDone: true }
    : [],
);
const mutate = mock(async (): Promise<unknown> => true);
const createExecutor = mock((): object => ({}));

const RUNTIME_PATH = import.meta
  .resolve("../../../../apps/core/src/shared/convex/runtime.ts");
const SANDBOX_PATH = import.meta
  .resolve("../../../../apps/core/src/harness/sandbox/index.ts");
const realRuntime = await import(RUNTIME_PATH);
const realSandbox = await import(SANDBOX_PATH);

await mock.module(RUNTIME_PATH, () => ({
  ...realRuntime,
  runtime: { query: query, mutate: mutate },
}));
await mock.module(SANDBOX_PATH, () => ({
  ...realSandbox,
  createSandboxExecutor: createExecutor,
}));

// Lazy so the module mocks above are in place first.
const { startSandboxSweeper, stopSandboxSweeper } =
  await import("../../../../apps/core/src/shared/sandbox-sweeper.ts");
const { runSandboxBackground } =
  await import("../../../../apps/core/src/harness/tools/filesystem-utils.ts");

afterEach((): void => {
  stopSandboxSweeper();
  delete process.env[SWEEP_INTERVAL_ENV];
});

function webpPart(tag: string, fill: (bytes: Buffer) => void): ImagePart {
  const bytes = Buffer.alloc(40);
  bytes.write("RIFF", 0, "latin1");
  bytes.write("WEBP", 8, "latin1");
  bytes.write(tag, 12, "latin1");
  fill(bytes);

  return {
    type: "image-data",
    data: bytes.toString("base64"),
    mediaType: "image/webp",
  };
}

function waitTurns(): Promise<void> {
  return new Promise((resolve): void => {
    setTimeout(resolve, 30);
  });
}

describe("job scripts", (): void => {
  test("generateJobId is prefixed", (): void => {
    expect(generateJobId()).toMatch(/^job_[0-9a-z]+$/);
  });

  test("logsScript tails the job log", (): void => {
    expect(logsScript("/jobs", "job_1", 100)).toBe(
      "tail -c 100 '/jobs/job_1.log' 2>/dev/null || true",
    );
  });

  test("logsScript refuses an unsafe id", (): void => {
    expect((): string => logsScript("/jobs", "../x", 1)).toThrow();
  });

  test("stopScript marks the exit", (): void => {
    expect(stopScript("/jobs", "job_1")).toContain(
      "echo 143 > '/jobs/job_1.exit'",
    );
  });

  test("stopScript refuses an unsafe id", (): void => {
    expect((): string => stopScript("/jobs", "a b")).toThrow();
  });
});

describe("webp sizes", (): void => {
  test.each([
    [
      "VP8 ",
      (bytes: Buffer): void => {
        bytes.writeUInt16LE(640, 26);
        bytes.writeUInt16LE(480, 28);
      },
    ],
    [
      "VP8L",
      (bytes: Buffer): void => {
        bytes.writeUInt32LE(639 | (479 << 14), 21);
      },
    ],
    [
      "VP8X",
      (bytes: Buffer): void => {
        bytes.writeUIntLE(639, 24, 3);
        bytes.writeUIntLE(479, 27, 3);
      },
    ],
  ])("%p is accepted", (tag: string, fill: (bytes: Buffer) => void): void => {
    expect(withImageLimits([webpPart(tag, fill)])[0]?.type).toBe("image-data");
  });

  test("an unknown chunk is refused", (): void => {
    expect(withImageLimits([webpPart("ABCD", (): void => {})])[0]?.type).toBe(
      "text",
    );
  });

  test("a short file is refused", (): void => {
    const short = Buffer.alloc(20);
    short.write("RIFF", 0, "latin1");
    short.write("WEBP", 8, "latin1");
    const part: ImagePart = {
      type: "image-data",
      data: short.toString("base64"),
      mediaType: "image/webp",
    };
    expect(withImageLimits([part])[0]?.type).toBe("text");
  });
});

describe("HarnessShellProcess", (): void => {
  test.each([
    [{ exitCode: 1, stdout: "", stderr: "boom" }, "boom"],
    [{ exitCode: 1, stdout: "out", stderr: "" }, "out"],
    [
      { exitCode: 2, stdout: "", stderr: "" },
      "Sandbox failed to spawn command (exit 2)",
    ],
  ])(
    "a failed launch reports %p",
    async (result: ShellResult, message: string): Promise<void> => {
      const executor = { exec: async (): Promise<ShellResult> => result };
      expect(
        HarnessShellProcess.start({
          executor: executor,
          command: "x",
          workingDirectory: "/w",
        }),
      ).rejects.toThrow(message);
    },
  );

  test("polls until the process is done", async (): Promise<void> => {
    let polls = 0;
    const executor = {
      exec: async (script: string): Promise<ShellResult> => {
        if (script.includes("echo running")) {
          polls += 1;

          return {
            exitCode: 0,
            stdout: polls > 2 ? "done 0\n" : "running\n",
            stderr: "",
          };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const process = await HarnessShellProcess.start({
      executor: executor,
      command: "true",
      workingDirectory: "/w",
    });
    expect(await process.wait()).toEqual({ exitCode: 0 });
    expect(polls).toBeGreaterThan(2);
  });
});

describe("readFileChunk", (): void => {
  const OFFSETS = Array.from({ length: 40 }, (_, index): number => index * 7);

  test.each(OFFSETS)(
    "reads from offset %p",
    async (offset: number): Promise<void> => {
      let script = "";
      const executor = {
        exec: async (command: string): Promise<ShellResult> => {
          script = command;

          return { exitCode: 0, stdout: "6 1 0\naGVsbG8K\n", stderr: "" };
        },
      };
      const chunk = await readFileChunk(executor, "/tmp/it's", offset);
      expect(chunk?.stamp).toBe("6 1 0");
      expect(script).toContain(`tail -c +${offset + 1} `);
    },
  );

  test("a missing file is null", async (): Promise<void> => {
    const executor = {
      exec: async (): Promise<ShellResult> => ({
        exitCode: 44,
        stdout: "",
        stderr: "",
      }),
    };
    expect(await readFileChunk(executor, "/nope", 0)).toBeNull();
  });

  test.each([
    [{ exitCode: 45, stdout: "", stderr: "is a directory" }, "is a directory"],
    [{ exitCode: 1, stdout: "partial", stderr: "" }, "partial"],
    [
      { exitCode: 3, stdout: "", stderr: "" },
      "Sandbox failed to read file (exit 3)",
    ],
  ])(
    "failure %p throws",
    async (result: ShellResult, message: string): Promise<void> => {
      const executor = { exec: async (): Promise<ShellResult> => result };
      expect(readFileChunk(executor, "/x", 0)).rejects.toThrow(message);
    },
  );

  test("forwards an abort signal", async (): Promise<void> => {
    const signals: unknown[] = [];
    const executor = {
      exec: async (
        _command: string,
        options?: object,
      ): Promise<ShellResult> => {
        signals.push(options);

        return { exitCode: 0, stdout: "1 1 0\n", stderr: "" };
      },
    };
    await readFileChunk(executor, "/x", 0, new AbortController().signal);
    expect(signals).toHaveLength(1);
  });
});

describe("readHarnessStream", (): void => {
  const TEXTS = [
    "",
    "a",
    "héllo",
    "two\nlines",
    "日本語",
    "🐝",
    "x".repeat(50),
    "end",
  ];

  test.each(TEXTS)(
    "decodes %p across chunks",
    async (text: string): Promise<void> => {
      const bytes = new TextEncoder().encode(text);
      const stream = new ReadableStream<Uint8Array>({
        start: function (controller): void {
          if (bytes.length > 0) {
            controller.enqueue(bytes.slice(0, 1));
            if (bytes.length > 1) controller.enqueue(bytes.slice(1));
          }
          controller.close();
        },
      });
      expect(await readHarnessStream(stream)).toBe(text);
    },
  );

  test("releases the reader when a read fails", async (): Promise<void> => {
    const stream = new ReadableStream<Uint8Array>({
      start: function (controller): void {
        controller.error(new Error("stream broke"));
      },
    });
    expect(readHarnessStream(stream)).rejects.toThrow("stream broke");
    await waitTurns();
    expect(stream.locked).toBe(false);
  });
});

describe("sandbox sweeper timers", (): void => {
  test("starts once and sweeps soon after boot", async (): Promise<void> => {
    process.env[SWEEP_INTERVAL_ENV] = "3600";
    const random = spyOn(Math, "random").mockReturnValue(0);
    query.mockClear();
    startSandboxSweeper();
    startSandboxSweeper();
    await waitTurns();
    random.mockRestore();
    expect(query).toHaveBeenCalled();
  });

  test("a failing sweep is contained", async (): Promise<void> => {
    const random = spyOn(Math, "random").mockReturnValue(0);
    query.mockImplementationOnce(async (): Promise<unknown> => {
      throw new Error("convex down");
    });
    startSandboxSweeper();
    await waitTurns();
    random.mockRestore();
    stopSandboxSweeper();
    stopSandboxSweeper();
    expect(query).toHaveBeenCalled();
  });
});

describe("runSandboxBackground", (): void => {
  const config = {
    provider: "lambda" as const,
    permissionMode: "ask" as const,
  };

  test("refuses a provider with no background jobs", (): void => {
    createExecutor.mockReturnValueOnce({});
    expect(
      runSandboxBackground(config, "ns", "sleep 1", { jobId: "job_1" }),
    ).rejects.toThrow("does not support background jobs");
  });

  test("passes the bounded limits to the executor", async (): Promise<void> => {
    const runBackground = mock(async (): Promise<object> => ({
      jobId: "job_2",
    }));
    createExecutor.mockReturnValueOnce({ runBackground: runBackground });
    expect(
      await runSandboxBackground(config, "ns", "sleep 1", { jobId: "job_2" }),
    ).toEqual({
      jobId: "job_2",
    });
    expect(runBackground).toHaveBeenCalledTimes(1);
  });

  test("forwards an optional callback and metadata", async (): Promise<void> => {
    const runBackground = mock(async (): Promise<object> => ({
      jobId: "job_3",
    }));
    createExecutor.mockReturnValueOnce({ runBackground: runBackground });
    await runSandboxBackground(config, "ns", "sleep 1", {
      jobId: "job_3",
      callback: { url: "https://example.test/cb", token: "t" },
      metadata: { agentId: "a" },
    });
    expect(runBackground).toHaveBeenCalledTimes(1);
  });
});
