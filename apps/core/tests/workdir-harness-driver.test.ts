/**
 * Workdir-first core driver contract tests. The driver receives a fake existing
 * executor reservation and never touches Convex, a real Workdir host, or the run loop.
 */

import { describe, expect, test } from "bun:test";
import type { Sandbox } from "@mv37/workdir";
import {
  WorkdirHarnessDriver,
  type WorkdirHarnessDriverOptions,
} from "../src/harness/sandbox/workdir-harness-driver.ts";

const encoder = new TextEncoder();

describe("WorkdirHarnessDriver", () => {
  test("maps an existing core reservation to command, file, port, and lifecycle operations", async () => {
    const fake = fakeWorkdir();
    const executor = fakeExecutor(fake.sandbox, true);
    const driver = new WorkdirHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const signal = new AbortController().signal;

    const created = await driver.createSession({
      sessionId: "session-1",
      identity: "bootstrap-v1",
      abortSignal: signal,
    });

    expect(created.isFirstCreate).toBe(true);
    expect(created.session.id).toBe("workdir-1");
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
    expect(
      await created.session.getPortUrl?.({ port: 4_321, protocol: "ws" }),
    ).toBe("wss://workdir.example.test/ports/4321");

    await created.session.stop();
    await created.session.destroy?.();
    expect(executor.suspensions).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
    expect(executor.releases).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
  });

  test("resumes the same reservation and rejects a mismatched bootstrap identity", async () => {
    const fake = fakeWorkdir();
    const executor = fakeExecutor(fake.sandbox, false);
    const driver = new WorkdirHarnessDriver(
      driverOptions(),
      executor.value as never,
    );

    await expect(
      driver.createSession({ identity: "other-bootstrap" }),
    ).rejects.toThrow("bootstrap identity does not match");

    const resumed = await driver.resumeSession?.({ sessionId: "session-1" });
    expect(resumed?.id).toBe("workdir-1");
    expect(executor.resumptions).toEqual([
      { reservationKey: "acct:agent:harness" },
    ]);
    expect(executor.acquisitions).toHaveLength(0);
  });

  test("kills a running Workdir process and rejects with the abort reason", async () => {
    const launched = Promise.withResolvers<void>();
    const fake = fakeWorkdir({
      processRunsUntilKilled: true,
      onLaunch: launched.resolve,
    });
    const executor = fakeExecutor(fake.sandbox, true);
    const driver = new WorkdirHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });
    const controller = new AbortController();
    const failure = new DOMException("turn cancelled", "AbortError");

    const command = session.runCommand({
      command: "sleep 60",
      abortSignal: controller.signal,
    });
    await launched.promise;
    controller.abort(failure);

    await expect(command).rejects.toBe(failure);
    await Bun.sleep(0);
    expect(fake.killCalls).toBe(1);
  });

  test("merges configured environment variables into each Harness command", async () => {
    const fake = fakeWorkdir();
    const executor = fakeExecutor(fake.sandbox, true);
    const options = driverOptions();
    options.config.envVars = {
      CONFIGURED: "base",
      OVERRIDDEN: "configured",
      OMITTED: undefined,
    };
    const driver = new WorkdirHarnessDriver(options, executor.value as never);
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });

    await session.runCommand({
      command: "env",
      env: { OVERRIDDEN: "per-command", COMMAND_ONLY: "value" },
    });

    expect(fake.launchEnvs).toEqual([
      {
        CONFIGURED: "base",
        OVERRIDDEN: "per-command",
        COMMAND_ONLY: "value",
      },
    ]);
  });

  test("drains all buffered output after a Workdir process exits", async () => {
    const expected = "x".repeat(64 * 1024 * 2 + 17);
    const fake = fakeWorkdir({ processStdout: encoder.encode(expected) });
    const executor = fakeExecutor(fake.sandbox, true);
    const driver = new WorkdirHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });

    expect(
      (await session.runCommand({ command: "generate output" })).stdout,
    ).toBe(expected);
  });

  test("rejects a spawned process wait when its signal aborts after launch", async () => {
    const launched = Promise.withResolvers<void>();
    const fake = fakeWorkdir({
      processRunsUntilKilled: true,
      onLaunch: launched.resolve,
    });
    const executor = fakeExecutor(fake.sandbox, true);
    const driver = new WorkdirHarnessDriver(
      driverOptions(),
      executor.value as never,
    );
    const { session } = await driver.createSession({
      identity: "bootstrap-v1",
    });
    const controller = new AbortController();
    const failure = new DOMException("spawn cancelled", "AbortError");

    const process = await session.spawnCommand({
      command: "sleep 60",
      abortSignal: controller.signal,
    });
    await launched.promise;
    const waiting = process.wait();
    controller.abort(failure);

    await expect(waiting).rejects.toBe(failure);
    await Bun.sleep(0);
    expect(fake.killCalls).toBe(1);
  });

  test("releases a newly claimed reservation when creation is aborted after allocation", async () => {
    const fake = fakeWorkdir();
    const controller = new AbortController();
    const failure = new DOMException(
      "cancelled after allocation",
      "AbortError",
    );
    const executor = fakeExecutor(fake.sandbox, true, () =>
      controller.abort(failure),
    );
    const driver = new WorkdirHarnessDriver(
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

function driverOptions(): WorkdirHarnessDriverOptions {
  return {
    reservationKey: "acct:agent:harness",
    bootstrapIdentity: "bootstrap-v1",
    config: {
      provider: "sandbox",
      persistent: true,
      options: {
        workdirUrl: "https://workdir.example.test",
        apiKey: "test-key",
      },
    },
    defaultWorkingDirectory: "/workspace",
    ports: [4_321],
  };
}

function fakeExecutor(
  sandbox: Sandbox,
  isFirstCreate: boolean,
  afterAcquire?: () => void,
) {
  const acquisitions: unknown[] = [];
  const resumptions: unknown[] = [];
  const suspensions: unknown[] = [];
  const releases: unknown[] = [];
  return {
    acquisitions,
    resumptions,
    suspensions,
    releases,
    value: {
      async acquireHarnessReservation(request: unknown) {
        acquisitions.push(request);
        afterAcquire?.();
        return { sandbox, isFirstCreate };
      },
      async resumeHarnessReservation(request: unknown) {
        resumptions.push(request);
        return sandbox;
      },
      async suspend(request: unknown) {
        suspensions.push(request);
      },
      async release(request: unknown) {
        releases.push(request);
      },
    },
  };
}

function fakeWorkdir(
  options: {
    processRunsUntilKilled?: boolean;
    processStdout?: Uint8Array;
    onLaunch?: () => void;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const temporaryFiles = new Map<string, string>();
  const processes = new Map<
    string,
    {
      stdout: Uint8Array;
      stderr: Uint8Array;
      exitCode: number;
      running: boolean;
    }
  >();
  const launchEnvs: Array<Record<string, string> | undefined> = [];
  let killCalls = 0;

  const sandbox = {
    id: "workdir-1",
    async exec(
      command: string,
      execOptions?: { env?: Record<string, string> },
    ) {
      const processRoot = command.match(
        /(\/tmp\/broods-harness-process-[0-9a-f-]+)/,
      )?.[1];
      if (command.includes("setsid bash") && processRoot) {
        launchEnvs.push(execOptions?.env);
        processes.set(processRoot, {
          stdout: options.processStdout ?? encoder.encode("hello\n"),
          stderr: encoder.encode("warning\n"),
          exitCode: 0,
          running: options.processRunsUntilKilled === true,
        });
        options.onLaunch?.();
        return result();
      }

      if (command.includes("kill -TERM") && processRoot) {
        killCalls += 1;
        const process = processes.get(processRoot);
        if (process) {
          process.running = false;
          process.exitCode = 143;
        }
        return result();
      }

      if (command.includes("dd if=") && processRoot) {
        const process = processes.get(processRoot);
        const stream = command.includes(".stderr")
          ? process?.stderr
          : process?.stdout;
        const skip = Number(command.match(/ skip=(\d+)/)?.[1] ?? 0);
        const count = Number(command.match(/ count=(\d+)/)?.[1] ?? 0);
        return result(
          Buffer.from(
            stream?.slice(skip, skip + count) ?? new Uint8Array(),
          ).toString("base64"),
        );
      }

      if (command.includes('echo "done $(cat') && processRoot) {
        const process = processes.get(processRoot);
        if (!process) return result("unknown\n");
        return result(
          process.running ? "running\n" : `done ${process.exitCode}\n`,
        );
      }

      const readPath = command.match(/base64 < '([^']+)'/)?.[1];
      if (readPath) {
        const content = files.get(readPath);
        return content === undefined
          ? result("", 44)
          : result(Buffer.from(content).toString("base64"));
      }

      const write = command.match(/base64 -d '([^']+)' > '([^']+)'/);
      if (write) {
        const encoded = temporaryFiles.get(write[1]!);
        if (encoded === undefined) return result("", 1, "missing upload");
        files.set(write[2]!, new Uint8Array(Buffer.from(encoded, "base64")));
        return result();
      }

      return result();
    },
    async writeFile(path: string, content: string) {
      temporaryFiles.set(path, content);
    },
    async exposePort(port: number) {
      return `https://workdir.example.test/ports/${port}`;
    },
  } as unknown as Sandbox;

  return {
    sandbox,
    launchEnvs,
    get killCalls() {
      return killCalls;
    },
  };
}

function result(stdout = "", exit_code = 0, stderr = "") {
  return { stdout, stderr, exit_code };
}
