/**
 * Core Lambda MicroVM Harness driver contract tests. These use an in-memory
 * executor and loopback proxy only; no AWS or shared control plane is touched.
 */

import { describe, expect, test } from "bun:test";
import {
  MicrovmHarnessDriver,
  type MicrovmHarnessDriverOptions,
} from "../src/harness/sandbox/microvm-harness-driver.ts";

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
  const files = new Map<string, Uint8Array>();
  const processes = new Map<
    string,
    { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }
  >();

  return {
    acquisitions,
    resumptions,
    suspensions,
    releases,
    authRequests,
    launchEnvs,
    value: {
      async acquireHarnessReservation(request: unknown) {
        acquisitions.push(request);
        afterAcquire?.();
        return {
          microvmId: "microvm-1",
          endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws",
          isFirstCreate,
        };
      },
      async resumeHarnessReservation(request: unknown) {
        resumptions.push(request);
        return {
          microvmId: "microvm-1",
          endpoint: "microvm-1.lambda-microvm.us-east-1.on.aws",
        };
      },
      async runHarnessCommand(request: {
        code: string;
        env?: Record<string, string>;
      }) {
        const processRoot = request.code.match(
          /(\/tmp\/broods-harness-process-[0-9a-f-]+)/,
        )?.[1];
        if (request.code.includes("setsid bash") && processRoot) {
          launchEnvs.push(request.env);
          processes.set(processRoot, {
            stdout: encoder.encode("hello\n"),
            stderr: encoder.encode("warning\n"),
            exitCode: 0,
          });
          return result();
        }
        if (request.code.includes("dd if=") && processRoot) {
          const process = processes.get(processRoot);
          const stream = request.code.includes(".stderr")
            ? process?.stderr
            : process?.stdout;
          const skip = Number(request.code.match(/ skip=(\d+)/)?.[1] ?? 0);
          const count = Number(request.code.match(/ count=(\d+)/)?.[1] ?? 0);
          return result(
            Buffer.from(
              stream?.slice(skip, skip + count) ?? new Uint8Array(),
            ).toString("base64"),
          );
        }
        if (request.code.includes('echo "done $(cat') && processRoot) {
          const process = processes.get(processRoot);
          return result(process ? `done ${process.exitCode}\n` : "unknown\n");
        }

        const write = request.code.match(
          /printf %s '([^']+)' \| base64 -d > '([^']+)'/,
        );
        if (write) {
          files.set(
            write[2]!,
            new Uint8Array(Buffer.from(write[1]!, "base64")),
          );
          return result();
        }
        const read = request.code.match(/if \[ -f '([^']+)' \]/);
        if (read) {
          const content = files.get(read[1]!);
          return content
            ? result(Buffer.from(content).toString("base64"))
            : result("", "", 44);
        }
        return result();
      },
      async createHarnessAuthToken(microvmId: string, port: number) {
        authRequests.push({ microvmId, port });
        return "secret-token";
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

function result(stdout = "", stderr = "", exitCode = 0) {
  return { stdout, stderr, exitCode };
}
