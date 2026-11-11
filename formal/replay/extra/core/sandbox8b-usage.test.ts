import { expect, test } from "bun:test";
import type { BroodsSandboxDriverSession } from "../../../../packages/ai-sdk-sandbox/src/index.ts";
import {
  reportSandboxUsage,
  type SandboxUsage,
} from "../../../../apps/core/src/harness/sandbox/live-status.ts";

type CommandResult = Awaited<
  ReturnType<BroodsSandboxDriverSession["runCommand"]>
>;

function sessionFor(
  runCommand: BroodsSandboxDriverSession["runCommand"],
): BroodsSandboxDriverSession {
  return {
    id: "usage-probe",
    description: "Offline usage probe",
    defaultWorkingDirectory: "/workspace",
    ports: [],
    runCommand: runCommand,
    spawnCommand: (): never => {
      throw new Error("unused");
    },
    readFile: (): never => {
      throw new Error("unused");
    },
    writeFile: (): never => {
      throw new Error("unused");
    },
    stop: (): never => {
      throw new Error("unused");
    },
  };
}

test.each([0, 1])(
  "usage probe publishes only exit zero (%d)",
  async (exitCode: number): Promise<void> => {
    const readings: SandboxUsage[] = [];
    const session = sessionFor(async (options): Promise<CommandResult> => {
      expect(options.command).toContain("/proc/meminfo");
      expect(options.abortSignal).toBeDefined();

      return {
        exitCode: exitCode,
        stdout: "cpus 2\nload 0.5\nmem 2048 1024\ndisk 1048576 524288\n",
        stderr: "",
      };
    });
    await reportSandboxUsage(session, (usage: SandboxUsage): void => {
      readings.push(usage);
    });

    expect(readings).toEqual(
      exitCode === 0
        ? [
            {
              cpus: 2,
              load1: 0.5,
              memoryTotalMb: 2,
              memoryUsedMb: 1,
              diskTotalGb: 1,
              diskUsedGb: 0.5,
            },
          ]
        : [],
    );
  },
);

test.each([false, true])(
  "usage probe combines cancellation when supplied (%s)",
  async (withSignal: boolean): Promise<void> => {
    const controller = new AbortController();
    const readings: SandboxUsage[] = [];
    const session = sessionFor(async (): Promise<CommandResult> => {
      throw new Error("probe unavailable");
    });
    await reportSandboxUsage(
      session,
      (usage: SandboxUsage): void => {
        readings.push(usage);
      },
      withSignal ? controller.signal : undefined,
    );

    expect(readings).toEqual([]);
  },
);

test("usage probe skips an already aborted signal", async (): Promise<void> => {
  const controller = new AbortController();
  controller.abort();
  let commands = 0;
  const session = sessionFor(async (): Promise<CommandResult> => {
    commands += 1;

    return { exitCode: 0, stdout: "", stderr: "" };
  });
  await reportSandboxUsage(
    session,
    (): never => {
      throw new Error("unexpected reading");
    },
    controller.signal,
  );

  expect(commands).toBe(0);
});
