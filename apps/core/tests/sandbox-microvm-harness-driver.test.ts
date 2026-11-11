import { describe, expect, test } from "bun:test";
import {
  MicrovmHarnessDriver,
  type MicrovmHarnessDriverOptions,
} from "../src/harness/sandbox/microvm-harness-driver.ts";
import {
  HARNESS_FILE_MAX_BYTES,
  HARNESS_OUTPUT_MAX_BYTES,
} from "../src/harness/sandbox/harness-shell-process.ts";
import { SandboxOutputTooLargeError } from "../src/shared/errors.ts";

const encoder = new TextEncoder();

describe("MicrovmHarnessDriver", () => {
  test("maps a persistent reservation to command, file, port, and lifecycle operations", async () => {
    const executor = fakeExecutor(true);
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const signal = new AbortController().signal;

    const created = await driver.createSession({
      identity: "bootstrap-v1",
      abortSignal: signal,
    });
    expect(created.isFirstCreate).toBe(true);
    expect(created.session.id).toBe("microvm-1");
    expect(created.session.description).not.toContain("secret");
    expect(created.session.defaultWorkingDirectory).toBe("/workspace");
    expect(created.session.ports).toEqual([4_321]);
    expect(executor.acquisitions).toEqual([
      { reservationKey: "acct:agent:harness", abortSignal: signal },
    ]);

    expect(await created.session.runCommand({ command: "echo hello" })).toEqual(
      {
        exitCode: 0,
        stdout: "hello\n",
        stderr: "warning\n",
      },
    );
    expect(executor.launchEnvs).toEqual([
      { CONFIGURED: "base", OVERRIDDEN: "configured" },
    ]);
    expect([...executor.commandReservationKeys]).toEqual([
      "acct:agent:harness",
    ]);

    await created.session.writeFile({
      path: "/workspace/data.bin",
      content: new Uint8Array([0, 1, 255]),
    });
    expect(
      await created.session.readFile({ path: "/workspace/data.bin" }),
    ).toEqual(new Uint8Array([0, 1, 255]));
    expect(
      await created.session.readFile({ path: "/workspace/missing" }),
    ).toBeNull();

    const portUrl = await created.session.getPortUrl!({
      port: 4_321,
      protocol: "ws",
    });
    expect(portUrl).toStartWith("ws://127.0.0.1:");
    expect(portUrl).not.toContain("microvm-1");
    expect(portUrl).not.toContain("secret-token");
    expect(executor.authRequests).toHaveLength(0);
    await expect(
      created.session.getPortUrl!({ port: 4_321, protocol: "http" }),
    ).rejects.toThrow("supports WebSocket ports only");

    await created.session.stop();
    await created.session.destroy?.();
    expect(executor.suspensions).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
    expect(executor.releases).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
  });

  test("reads files past one exec's stdout cap in chunks", async () => {
    const executor = fakeExecutor(true);
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });

    // Past the cap, an exact multiple of the chunk size, and empty.
    for (const size of [300_000, 2 * 180 * 1024, 0]) {
      const content = new Uint8Array(size).map((_, index) => index % 251);
      await session.writeFile({
        path: "/workspace/file.bin",
        content: content,
      });
      expect(await session.readFile({ path: "/workspace/file.bin" })).toEqual(
        content,
      );
    }
    expect(executor.chunkReads).toEqual([
      "/workspace/file.bin@0",
      "/workspace/file.bin@184320",
      "/workspace/file.bin@0",
      "/workspace/file.bin@184320",
      "/workspace/file.bin@0",
    ]);
  });

  test("refuses a file over the harness read cap after its first chunk", async () => {
    const executor = fakeExecutor(true);
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });
    executor.files.set(
      "/workspace/huge.bin",
      new Uint8Array(HARNESS_FILE_MAX_BYTES + 1),
    );

    const read = session.readFile({ path: "/workspace/huge.bin" });

    await expect(read).rejects.toThrow(
      `/workspace/huge.bin is ${HARNESS_FILE_MAX_BYTES + 1} bytes, over the`,
    );
    expect(executor.chunkReads).toEqual(["/workspace/huge.bin@0"]);
  });

  test("kills a still-running command past the output cap and stops polling it", async () => {
    const executor = fakeExecutor(true);
    executor.runProcessesUntilKilled(
      new Uint8Array(HARNESS_OUTPUT_MAX_BYTES + 1).fill(120),
    );
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });

    const run = session.runCommand({ command: "cat big.bin" });

    await expect(run).rejects.toBeInstanceOf(SandboxOutputTooLargeError);
    expect(executor.killCalls).toBe(1);
    expect(executor.runningProcesses).toBe(0);
    const commandCalls = executor.commandCalls;
    await Bun.sleep(200);
    expect(executor.commandCalls).toBe(commandCalls);
  });

  test("refuses to stitch a file that changed between chunks", async () => {
    const executor = fakeExecutor(true);
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });
    await session.writeFile({
      path: "/workspace/shot.png",
      content: new Uint8Array(300_000),
    });
    executor.onChunkRead(() =>
      executor.files.set("/workspace/shot.png", new Uint8Array(300_000)),
    );

    await expect(
      session.readFile({ path: "/workspace/shot.png" }),
    ).rejects.toThrow("changed while it was being read");
  });

  test("resumes the same reservation and validates bootstrap identity", async () => {
    const executor = fakeExecutor(false);
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );

    await expect(
      driver.createSession({ identity: "other-bootstrap" }),
    ).rejects.toThrow("bootstrap identity does not match");

    const resumed = await driver.resumeSession?.({ sessionId: "session-1" });
    expect(resumed?.id).toBe("microvm-1");
    expect(executor.resumptions).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
    await resumed?.destroy?.();
  });

  test("releases a newly created reservation when allocation is aborted", async () => {
    const controller = new AbortController();
    const failure = new DOMException(
      "cancelled after allocation",
      "AbortError",
    );
    const executor = fakeExecutor(true, () => controller.abort(failure));
    const driver = new MicrovmHarnessDriver(
      driverOptions(),
      executor.value as never,
    );

    await expect(
      driver.createSession({
        identity: "bootstrap-v1",
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(failure);
    expect(executor.releases).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
  });
});

function driverOptions(): MicrovmHarnessDriverOptions {
  return {
    reservationKey: "acct:agent:harness",
    bootstrapIdentity: "bootstrap-v1",
    config: {
      provider: "lambda",
      persistent: true,
      envVars: {
        CONFIGURED: "base",
        OVERRIDDEN: "configured",
        OMITTED: undefined,
      },
    },
    defaultWorkingDirectory: "/workspace",
    ports: [4_321],
  };
}

function fakeExecutor(isFirstCreate: boolean, afterAcquire?: () => void) {
  const acquisitions: unknown[] = [];
  const resumptions: unknown[] = [];
  const suspensions: unknown[] = [];
  const releases: unknown[] = [];
  const authRequests: unknown[] = [];
  const launchEnvs: Array<Record<string, string> | undefined> = [];
  const commandReservationKeys = new Set<string>();
  const chunkReads: string[] = [];
  const files = new Map<string, Uint8Array>();
  // Bumped on every write, standing in for the inode and change time in a stamp.
  const versions = new Map<Uint8Array, number>();
  let afterChunkRead: (() => void) | undefined;
  let longRunningStdout: Uint8Array | undefined;
  let killCalls = 0;
  let commandCalls = 0;
  const processes = new Map<
    string,
    {
      stdout: Uint8Array;
      stderr: Uint8Array;
      exitCode: number;
      running: boolean;
    }
  >();

  return {
    acquisitions: acquisitions,
    resumptions: resumptions,
    suspensions: suspensions,
    releases: releases,
    authRequests: authRequests,
    launchEnvs: launchEnvs,
    commandReservationKeys: commandReservationKeys,
    chunkReads: chunkReads,
    files: files,
    onChunkRead: function (callback: () => void): void {
      afterChunkRead = callback;
    },
    runProcessesUntilKilled: function (stdout: Uint8Array): void {
      longRunningStdout = stdout;
    },
    get killCalls() {
      return killCalls;
    },
    get commandCalls() {
      return commandCalls;
    },
    get runningProcesses() {
      return [...processes.values()].filter((process) => process.running)
        .length;
    },
    value: {
      acquireHarnessReservation: async function (request: unknown) {
        acquisitions.push(request);
        afterAcquire?.();

        return {
          microvmId: "microvm-1",
          endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws",
          isFirstCreate: isFirstCreate,
        };
      },
      resumeHarnessReservation: async function (request: unknown) {
        resumptions.push(request);

        return {
          microvmId: "microvm-1",
          endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws",
        };
      },
      runHarnessCommand: async function (request: {
        reservationKey: string;
        code: string;
        env?: Record<string, string>;
      }) {
        commandCalls += 1;
        commandReservationKeys.add(request.reservationKey);
        const processRoot = request.code.match(
          /(\/tmp\/broods-harness-process-[0-9a-f-]+)/,
        )?.[1];
        if (request.code.includes("setsid bash") && processRoot) {
          launchEnvs.push(request.env);
          processes.set(processRoot, {
            stdout: longRunningStdout ?? encoder.encode("hello\n"),
            stderr: encoder.encode("warning\n"),
            exitCode: 0,
            running: longRunningStdout !== undefined,
          });

          return result();
        }
        if (request.code.includes("kill -TERM") && processRoot) {
          killCalls += 1;
          const process = processes.get(processRoot);
          if (process) {
            process.running = false;
            process.exitCode = 143;
          }

          return result();
        }
        const chunk = request.code.match(
          /if \[ -f '([^']+)' \]; then stat .* tail -c \+(\d+) .* head -c (\d+)/,
        );
        if (chunk) {
          const path = chunk[1]!;
          const process = processRoot ? processes.get(processRoot) : undefined;
          const content = processRoot
            ? path.endsWith(".stderr")
              ? process?.stderr
              : process?.stdout
            : files.get(path);
          if (!content) return result("", "", 44);
          const start = Number(chunk[2]) - 1;
          if (!processRoot) chunkReads.push(`${path}@${start}`);
          const stamp = `${content.byteLength} ${versions.get(content) ?? 0}`;
          const bytes = content.slice(start, start + Number(chunk[3]));
          afterChunkRead?.();

          return result(`${stamp}\n${Buffer.from(bytes).toString("base64")}`);
        }
        if (request.code.includes('echo "done $(cat') && processRoot) {
          const process = processes.get(processRoot);

          if (!process) return result("unknown\n");

          return result(
            process.running ? "running\n" : `done ${process.exitCode}\n`,
          );
        }

        const write = request.code.match(
          /printf %s '([^']*)' \| base64 -d > '([^']+)'/,
        );
        if (write) {
          const content = new Uint8Array(Buffer.from(write[1]!, "base64"));
          versions.set(content, versions.size + 1);
          files.set(write[2]!, content);

          return result();
        }

        return result();
      },
      createHarnessAuthToken: async function (microvmId: string, port: number) {
        authRequests.push({ microvmId: microvmId, port: port });

        return "secret-token";
      },
      suspend: async function (request: unknown) {
        suspensions.push(request);
      },
      release: async function (request: unknown) {
        releases.push(request);
      },
    },
  };
}

function result(
  stdout = "",
  stderr = "",
  exitCode = 0,
): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: stdout, stderr: stderr, exitCode: exitCode };
}
