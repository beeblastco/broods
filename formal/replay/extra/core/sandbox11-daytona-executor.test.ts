import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { DaytonaSandboxExecutor as Executor } from "../../../../apps/core/src/harness/sandbox/daytona-executor.ts";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";

interface Reply {
  exitCode?: number;
  result?: string;
  artifacts?: { stdout: string };
}

interface FakeDaytona {
  id: string;
  state: string;
  cpu: number;
  memory: number;
  disk: number;
  start: () => Promise<void>;
  delete: () => Promise<void>;
  process: { executeCommand: (...args: unknown[]) => Promise<Reply> };
}

type Spy = { mockRestore: () => void };

const KEY = "custom-tool:acct_1:key";
let spies: Spy[] = [];
let replies: Reply[] = [];
let commands: unknown[][] = [];
let getImpl: (id: string) => Promise<FakeDaytona> = async (
  id: string,
): Promise<FakeDaytona> => box(id);
let createImpl: () => Promise<FakeDaytona> = async (): Promise<FakeDaytona> =>
  box("fresh");
let made: FakeDaytona[] = [];
let starts: string[] = [];
let deletes: string[] = [];

function box(id: string, state = "started"): FakeDaytona {
  const sandbox: FakeDaytona = {
    id: id,
    state: state,
    cpu: 2,
    memory: 4,
    disk: 10,
    start: async (): Promise<void> => {
      starts.push(id);
    },
    delete: async (): Promise<void> => {
      deletes.push(id);
    },
    process: {
      executeCommand: async (...args: unknown[]): Promise<Reply> => {
        commands.push(args);

        return replies.shift() ?? { exitCode: 0, result: "ok\n" };
      },
    },
  };
  made.push(sandbox);

  return sandbox;
}

await mock.module("@daytona/sdk", () => ({
  Daytona: class {
    create = (): Promise<FakeDaytona> => createImpl();
    get = (id: string): Promise<FakeDaytona> => getImpl(id);
  },
}));

// Lazy: the executor imports the Daytona SDK eagerly, so the mock above must be in place first.
const { DaytonaSandboxExecutor } =
  await import("../../../../apps/core/src/harness/sandbox/daytona-executor.ts");

function config(
  extra: Partial<SandboxExecutorConfig> = {},
): SandboxExecutorConfig {
  return {
    provider: "daytona",
    persistent: true,
    options: { apiKey: "key" },
    ...extra,
  } as SandboxExecutorConfig;
}

function launch(
  executor: Executor,
  extra: Record<string, unknown> = {},
): ReturnType<Executor["runBackground"]> {
  return executor.runBackground({
    code: "echo hi",
    reservationKey: KEY,
    timeoutSeconds: 30,
    outputLimitBytes: 1024,
    jobId: "job_1",
    ...extra,
  });
}

function stored(...ids: Array<string | undefined>): void {
  const spy = spyOn(instanceStore, "getSandboxExternalId");
  for (const id of ids) spy.mockResolvedValueOnce(id as string);
  spy.mockResolvedValue(undefined as unknown as string);
  spies.push(spy);
}

function gone(): Error {
  return Object.assign(new Error("sandbox not found"), { statusCode: 404 });
}

let claim: ReturnType<
  typeof spyOn<typeof instanceStore, "claimSandboxInstance">
>;
let removeRow: ReturnType<
  typeof spyOn<typeof instanceStore, "deleteSandboxInstance">
>;
let upsert: ReturnType<
  typeof spyOn<typeof sandboxInstances, "upsertSandboxInstance">
>;

beforeEach((): void => {
  replies = [];
  commands = [];
  made = [];
  starts = [];
  deletes = [];
  getImpl = async (id: string): Promise<FakeDaytona> => box(id);
  createImpl = async (): Promise<FakeDaytona> => box("fresh");
  claim = spyOn(instanceStore, "claimSandboxInstance").mockResolvedValue(true);
  removeRow = spyOn(instanceStore, "deleteSandboxInstance").mockResolvedValue(
    undefined,
  );
  upsert = spyOn(sandboxInstances, "upsertSandboxInstance").mockResolvedValue(
    undefined,
  );
  spies = [
    claim,
    removeRow,
    upsert,
    spyOn(instanceStore, "saveSandboxInstance").mockResolvedValue(undefined),
  ];
});

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
});

describe("daytona acquire", () => {
  test("restarts a stopped sandbox it reconnects to", async (): Promise<void> => {
    stored("ext-1");
    const stopped = box("ext-1", "stopped");
    getImpl = async (): Promise<FakeDaytona> => stopped;

    const handle = await launch(new DaytonaSandboxExecutor(config()));

    expect(handle).toEqual({ jobId: "job_1", externalId: "ext-1" });
    expect(starts).toEqual(["ext-1"]);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test("recreates a sandbox the provider no longer has", async (): Promise<void> => {
    stored("ext-1");
    getImpl = async (): Promise<FakeDaytona> => {
      throw gone();
    };

    const handle = await launch(new DaytonaSandboxExecutor(config()));

    expect(handle.externalId).toBe("fresh");
    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test("keeps the stored sandbox on a transient lookup error", async (): Promise<void> => {
    stored("ext-1");
    getImpl = async (): Promise<FakeDaytona> => {
      throw new Error("upstream broke");
    };

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "upstream broke",
    );
    expect(removeRow).toHaveBeenCalledTimes(0);
  });

  test("connects to the winner and drops its own sandbox when the claim is lost", async (): Promise<void> => {
    stored(undefined, "winner");
    claim.mockResolvedValue(false);

    const handle = await launch(new DaytonaSandboxExecutor(config()));

    expect(handle.externalId).toBe("winner");
    expect(deletes).toEqual(["fresh"]);
  });

  test("fails when the claim is lost and no winner row exists", async (): Promise<void> => {
    stored(undefined, undefined);
    claim.mockResolvedValue(false);

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "lost create race",
    );
  });

  test("undoes both sides when the claim call fails", async (): Promise<void> => {
    stored(undefined);
    claim.mockRejectedValue(new Error("claim exploded"));

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "claim exploded",
    );
    expect(deletes).toHaveLength(1);
    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test("turns a runner shortage into a capacity error", async (): Promise<void> => {
    stored(undefined);
    createImpl = async (): Promise<FakeDaytona> => {
      throw new Error("No available runners");
    };

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "no available runner for the request",
    );
  });

  test("passes any other create failure through", async (): Promise<void> => {
    stored(undefined);
    createImpl = async (): Promise<FakeDaytona> => {
      throw new Error("quota");
    };

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "quota",
    );
  });
});

describe("daytona background jobs", () => {
  test("refuses a sandbox with no reservation", async (): Promise<void> => {
    await expect(
      new DaytonaSandboxExecutor(config({ persistent: false })).runBackground({
        code: "x",
        timeoutSeconds: 1,
        outputLimitBytes: 1,
      }),
    ).rejects.toThrow("require a persistent daytona sandbox");
  });

  test("runs the lifecycle hooks before launching", async (): Promise<void> => {
    stored("ext-1");

    await launch(new DaytonaSandboxExecutor(config({ onCreate: ["npm i"] })), {
      callback: { url: "https://hook.test/cb", token: "tok" },
    });

    expect(commands).toHaveLength(2);
    expect(String(commands[0]?.[0])).toContain("npm i");
    expect(commands[1]?.[2]).toEqual({ __CB_TOKEN: "tok" });
  });

  test("reports a failed lifecycle hook", async (): Promise<void> => {
    stored("ext-1");
    replies = [{ exitCode: 1, artifacts: { stdout: "hook broke" } }];

    await expect(
      launch(new DaytonaSandboxExecutor(config({ onResume: ["x"] }))),
    ).rejects.toThrow("hook broke");
  });

  test("falls back when a failed hook printed nothing", async (): Promise<void> => {
    stored("ext-1");
    replies = [{ exitCode: 1 }];

    await expect(
      launch(new DaytonaSandboxExecutor(config({ onResume: ["x"] }))),
    ).rejects.toThrow("daytona lifecycle hook failed");
  });

  test("reports what a failed launch printed", async (): Promise<void> => {
    stored("ext-1");
    replies = [{ exitCode: 7, result: "no room" }];

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "no room",
    );
  });

  test("falls back when a failed launch printed nothing", async (): Promise<void> => {
    stored("ext-1");
    replies = [{ exitCode: 7 }];

    await expect(launch(new DaytonaSandboxExecutor(config()))).rejects.toThrow(
      "failed to launch background job",
    );
  });

  test("reads a job's status, logs and stop", async (): Promise<void> => {
    const executor = new DaytonaSandboxExecutor(config());
    const ref = { jobId: "job_1", reservationKey: KEY };

    stored("ext-1");
    replies = [{ exitCode: 0, result: "done 0\n" }];
    expect(await executor.jobStatus(ref)).toEqual({
      jobId: "job_1",
      state: "completed",
      exitCode: 0,
    });

    stored("ext-1");
    replies = [{ exitCode: 0, result: "line one\n" }];
    expect(await executor.jobLogs(ref)).toEqual({
      jobId: "job_1",
      logs: "line one\n",
      truncated: false,
    });

    stored("ext-1");
    replies = [
      { exitCode: 0 },
      { exitCode: 0, artifacts: { stdout: "done 137\n" } },
    ];
    expect(await executor.stopJob(ref)).toEqual({
      jobId: "job_1",
      state: "failed",
      exitCode: 137,
    });
  });

  test("a job call needs a stored reservation", async (): Promise<void> => {
    stored(undefined);

    await expect(
      new DaytonaSandboxExecutor(config()).jobStatus({
        jobId: "job_1",
        reservationKey: KEY,
      }),
    ).rejects.toThrow("no reserved daytona sandbox");
  });

  test("a job call needs a reservation key", async (): Promise<void> => {
    await expect(
      new DaytonaSandboxExecutor(config()).jobLogs({ jobId: "job_1" }),
    ).rejects.toThrow("a persistent sandbox reservation key is required");
  });
});

describe("daytona run", () => {
  test("runs the lifecycle hooks of a reserved sandbox before the command", async (): Promise<void> => {
    stored("ext-1");

    const result = await new DaytonaSandboxExecutor(
      config({ onCreate: ["npm i"] }),
    ).run({
      code: "echo hi",
      reservationKey: KEY,
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "daytona",
      stdout: "ok\n",
    });
    expect(commands).toHaveLength(2);
  });

  test("warns about a restricted allowlist and keeps the CIDRs", async (): Promise<void> => {
    const result = await new DaytonaSandboxExecutor(
      config({
        persistent: false,
        network: {
          mode: "restricted",
          allowDomains: ["a.example.com"],
          allowCidrs: ["10.0.0.0/8"],
        },
      }),
    ).run({
      code: "echo hi",
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });

    expect(result.ok).toBe(true);
    expect(deletes).toHaveLength(1);
  });

  test("mounts with the sandbox's own AWS keys when no mount role is set", async (): Promise<void> => {
    const result = await new DaytonaSandboxExecutor(
      config({
        persistent: false,
        envVars: {
          AWS_ACCESS_KEY_ID: "ak",
          AWS_SECRET_ACCESS_KEY: "sk",
          AWS_SESSION_TOKEN: "st",
        },
        options: {
          apiKey: "key",
          mountAwsS3Buckets: true,
          workspaceBucketName: "bkt",
        },
      }),
    ).run({
      code: "echo hi",
      namespace: "ns-1",
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });

    expect(result.ok).toBe(true);
  });

  test("passes only the keys it has when the sandbox env has no session token", async (): Promise<void> => {
    const result = await new DaytonaSandboxExecutor(
      config({
        persistent: false,
        network: { mode: "allow-all" },
        envVars: { AWS_ACCESS_KEY_ID: "ak", AWS_SECRET_ACCESS_KEY: "sk" },
        options: {
          apiKey: "key",
          mountAwsS3Buckets: true,
          workspaceBucketName: "bkt",
        },
      }),
    ).run({
      code: "echo hi",
      namespace: "ns-1",
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });

    expect(result.ok).toBe(true);
  });

  test("refuses a mount with no AWS keys at all", async (): Promise<void> => {
    await expect(
      new DaytonaSandboxExecutor(
        config({
          persistent: false,
          options: {
            apiKey: "key",
            mountAwsS3Buckets: true,
            workspaceBucketName: "bkt",
          },
        }),
      ).run({
        code: "echo hi",
        namespace: "ns-1",
        timeoutSeconds: 30,
        outputLimitBytes: 1024,
      }),
    ).rejects.toThrow("Daytona AWS S3 mounts require");
  });

  test("names the setup command that failed", async (): Promise<void> => {
    replies = [{ exitCode: 1, result: "denied" }];

    await expect(
      new DaytonaSandboxExecutor(
        config({
          persistent: false,
          envVars: { AWS_ACCESS_KEY_ID: "ak", AWS_SECRET_ACCESS_KEY: "sk" },
          options: {
            apiKey: "key",
            mountAwsS3Buckets: true,
            workspaceBucketName: "bkt",
          },
        }),
      ).run({
        code: "echo hi",
        namespace: "ns-1",
        timeoutSeconds: 30,
        outputLimitBytes: 1024,
      }),
    ).rejects.toThrow("Daytona setup command failed");
    expect(deletes).toHaveLength(1);
  });
});

describe("daytona release", () => {
  const executor = (): Executor => new DaytonaSandboxExecutor(config());

  test("ignores a request with no reservation key", async (): Promise<void> => {
    await executor().release({});
    expect(removeRow).toHaveBeenCalledTimes(0);
  });

  test("ignores a reservation with no stored sandbox", async (): Promise<void> => {
    stored(undefined);
    await executor().release({ reservationKey: KEY });
    expect(removeRow).toHaveBeenCalledTimes(0);
  });

  test("still drops the row when the sandbox is already gone", async (): Promise<void> => {
    getImpl = async (): Promise<FakeDaytona> => {
      throw gone();
    };

    await executor().release({ reservationKey: KEY, expectedExternalId: "x" });

    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test("rethrows a release failure that is not a gone sandbox", async (): Promise<void> => {
    getImpl = async (): Promise<FakeDaytona> => {
      throw new Error("boom");
    };

    await expect(
      executor().release({ reservationKey: KEY, expectedExternalId: "x" }),
    ).rejects.toThrow("boom");
  });
});
