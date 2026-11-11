import { describe, expect, test } from "bun:test";
import type { Sandbox } from "@mv37/workdir";

import {
  WorkdirHarnessDriver,
  type WorkdirHarnessDriverOptions,
} from "../../../../apps/core/src/harness/sandbox/workdir-harness-driver.ts";

interface FakeExec {
  exit_code: number;
  stdout: string;
  stderr: string;
}

function options(apiKey: string | undefined): WorkdirHarnessDriverOptions {
  return {
    reservationKey: "acct:agent:s16",
    config: {
      provider: "sandbox",
      persistent: true,
      options: {
        workdirUrl: "https://workdir.example.test",
        ...(apiKey ? { apiKey: apiKey } : {}),
      },
    },
  };
}

function fakeSandbox(exec: (command: string) => FakeExec): Sandbox {
  return {
    id: "workdir-1",
    exec: async (command: string): Promise<FakeExec> => exec(command),
    writeFile: async (): Promise<void> => {},
    exposePort: async (port: number): Promise<string> =>
      `https://workdir.example.test/ports/${port}`,
  } as unknown as Sandbox;
}

async function sessionOf(
  driverOptions: WorkdirHarnessDriverOptions,
  sandbox: Sandbox,
  lifecycle: object = {},
): Promise<
  Awaited<ReturnType<WorkdirHarnessDriver["createSession"]>>["session"]
> {
  const driver = new WorkdirHarnessDriver(driverOptions, {
    acquireHarnessReservation: async (): Promise<object> => ({
      sandbox: sandbox,
      isFirstCreate: false,
    }),
    resumeHarnessReservation: async (): Promise<Sandbox> => sandbox,
    ...lifecycle,
  } as never);

  return (await driver.createSession({ sessionId: "session-1" })).session;
}

describe("WorkdirHarnessSession.readFile", (): void => {
  test("a path that cannot be read is an error with the shell's words", async (): Promise<void> => {
    const session = await sessionOf(
      options("k"),
      fakeSandbox((): FakeExec => ({
        exit_code: 45,
        stdout: "",
        stderr: "is a directory",
      })),
    );

    await expect(session.readFile({ path: "/workspace/dir" })).rejects.toThrow(
      "is a directory",
    );
  });
});

describe("WorkdirHarnessSession.writeFile", (): void => {
  test("a failed write reports the exit code", async (): Promise<void> => {
    const session = await sessionOf(
      options("k"),
      fakeSandbox((command: string): FakeExec =>
        command.startsWith("rm")
          ? { exit_code: 0, stdout: "", stderr: "" }
          : { exit_code: 1, stdout: "", stderr: "" },
      ),
    );

    await expect(
      session.writeFile({ path: "/readonly/x", content: new Uint8Array([1]) }),
    ).rejects.toThrow("Workdir failed to write file (exit 1)");
  });
});

describe("WorkdirHarnessSession.getPortUrl", (): void => {
  const ok = (): FakeExec => ({ exit_code: 0, stdout: "", stderr: "" });

  test("port exposure needs an API key", async (): Promise<void> => {
    const saved = process.env.WORKDIR_API_KEY;
    delete process.env.WORKDIR_API_KEY;
    const session = await sessionOf(options(undefined), fakeSandbox(ok));

    await expect(session.getPortUrl?.({ port: 8080 })).rejects.toThrow(
      "port exposure requires an API key",
    );
    if (saved !== undefined) process.env.WORKDIR_API_KEY = saved;
  });

  test("an explicit protocol replaces the exposed one", async (): Promise<void> => {
    const session = await sessionOf(options("k"), fakeSandbox(ok));
    const url = new URL(
      (await session.getPortUrl?.({ port: 8080, protocol: "http" })) ?? "",
    );

    expect(url.protocol).toBe("http:");
    expect(url.searchParams.get("key")).toBe("k");
  });
});

describe("WorkdirHarnessSession lifecycle", (): void => {
  test("an executor that cannot suspend or release says so", async (): Promise<void> => {
    const session = await sessionOf(
      options("k"),
      fakeSandbox((): FakeExec => ({
        exit_code: 0,
        stdout: "",
        stderr: "",
      })),
    );

    await expect(session.stop()).rejects.toThrow("cannot be suspended");
    await expect(session.destroy?.()).rejects.toThrow("cannot be released");
  });
});
