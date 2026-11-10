import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import type {
  SandboxExecutorConfig,
  SandboxRunRequest,
} from "../../../../apps/core/src/harness/sandbox/types.ts";
import { VercelSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/vercel-executor.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";

interface FakeResult {
  exitCode: number;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
}

interface FakeSandbox {
  name: string;
  createdAt: Date;
  networkId?: string;
  runCommand: (input: unknown) => Promise<FakeResult>;
  update: (input: unknown) => Promise<void>;
  extendTimeout: (ms: number) => Promise<void>;
  delete: () => Promise<void>;
  stop: () => Promise<void>;
}

type Spy = { mockRestore: () => void };

const KEY = "fs-0123456789abcdef0123456789abcdef01234567";
let outputs: Array<Partial<FakeResult> & { exitCode: number }> = [];
let spies: Spy[] = [];

function result(exitCode: number, stdout = "", stderr = ""): FakeResult {
  return {
    exitCode: exitCode,
    stdout: async (): Promise<string> => stdout,
    stderr: async (): Promise<string> => stderr,
  };
}

function fakeSandbox(): FakeSandbox {
  return {
    name: "vercel-box",
    createdAt: new Date(),
    runCommand: async (): Promise<FakeResult> => {
      const next = outputs.shift();

      return next ? { ...result(next.exitCode), ...next } : result(0);
    },
    update: async (): Promise<void> => {},
    extendTimeout: async (): Promise<void> => {},
    delete: async (): Promise<void> => {},
    stop: async (): Promise<void> => {},
  };
}

await mock.module("@vercel/sandbox", () => ({
  Sandbox: {
    create: async (): Promise<FakeSandbox> => fakeSandbox(),
    get: async (): Promise<FakeSandbox> => fakeSandbox(),
  },
}));

function config(persistent: boolean): SandboxExecutorConfig {
  return {
    provider: "vercel",
    persistent: persistent,
    options: { token: "tok", teamId: "team_1", projectId: "prj_1" },
  } as SandboxExecutorConfig;
}

function runRequest(jobId?: string): SandboxRunRequest {
  return {
    code: "echo hi",
    reservationKey: KEY,
    timeoutSeconds: 30,
    outputLimitBytes: 1024,
    ...(jobId ? { jobId: jobId } : {}),
  } as SandboxRunRequest;
}

function jobRequest(): { jobId: string; reservationKey: string } {
  return { jobId: "job-1", reservationKey: KEY };
}

function useStoredName(name: string | undefined): void {
  spies.push(
    spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(
      name as string,
    ),
  );
}

beforeEach((): void => {
  outputs = [];
  spies = [
    spyOn(instanceStore, "saveSandboxInstance").mockResolvedValue(undefined),
    spyOn(sandboxInstances, "upsertSandboxInstance").mockResolvedValue(
      undefined,
    ),
  ];
});

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
});

describe("vercel background jobs", () => {
  test("launches a job on the reserved sandbox", async (): Promise<void> => {
    useStoredName("vercel-box");
    const handle = await new VercelSandboxExecutor(config(true)).runBackground(
      runRequest("job-1"),
    );

    expect(handle).toEqual({ jobId: "job-1", externalId: "vercel-box" });
  });

  test("reports what a failed launch printed", async (): Promise<void> => {
    useStoredName("vercel-box");
    outputs = [{ exitCode: 0 }, { ...result(7, "", "no room") }];

    await expect(
      new VercelSandboxExecutor(config(true)).runBackground(
        runRequest("job-1"),
      ),
    ).rejects.toThrow("no room");
  });

  test("falls back when a failed launch printed nothing", async (): Promise<void> => {
    useStoredName("vercel-box");
    outputs = [{ exitCode: 0 }, { ...result(7) }];

    await expect(
      new VercelSandboxExecutor(config(true)).runBackground(
        runRequest("job-1"),
      ),
    ).rejects.toThrow("failed to launch background job");
  });

  test("refuses a sandbox with no reservation", async (): Promise<void> => {
    await expect(
      new VercelSandboxExecutor(config(false)).runBackground(runRequest()),
    ).rejects.toThrow("background jobs require a persistent");
  });

  test("reads a job's status, logs and stop", async (): Promise<void> => {
    useStoredName("vercel-box");
    const executor = new VercelSandboxExecutor(config(true));

    outputs = [{ ...result(0, "done 0\n") }];
    expect(await executor.jobStatus(jobRequest())).toEqual({
      jobId: "job-1",
      state: "completed",
      exitCode: 0,
    });

    outputs = [{ ...result(0, "line one\n") }];
    expect(await executor.jobLogs(jobRequest())).toEqual({
      jobId: "job-1",
      logs: "line one\n",
      truncated: false,
    });

    outputs = [{ exitCode: 0 }, { ...result(0, "done 137\n") }];
    expect(await executor.stopJob(jobRequest())).toEqual({
      jobId: "job-1",
      state: "failed",
      exitCode: 137,
    });
  });

  test("a job call needs a stored reservation", async (): Promise<void> => {
    useStoredName(undefined);

    await expect(
      new VercelSandboxExecutor(config(true)).jobStatus(jobRequest()),
    ).rejects.toThrow("no reserved vercel sandbox");
  });

  test("a job call needs a reservation key", async (): Promise<void> => {
    await expect(
      new VercelSandboxExecutor(config(true)).jobLogs({ jobId: "job-1" }),
    ).rejects.toThrow("a persistent sandbox reservation key is required");
  });
});
