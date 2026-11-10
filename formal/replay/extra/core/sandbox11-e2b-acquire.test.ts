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
import { E2BSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/e2b-executor.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";

interface FakeHandle {
  disconnect: () => Promise<void>;
}

interface FakeE2B {
  sandboxId: string;
  commands: { run: (code: string, options: unknown) => Promise<FakeHandle> };
}

type Spy = { mockRestore: () => void };

const KEY = "custom-tool:acct_1:key";
let spies: Spy[] = [];
let connectImpl: (id: string) => Promise<FakeE2B> = async (
  id: string,
): Promise<FakeE2B> => box(id);
let killImpl: (id: string) => Promise<void> = async (): Promise<void> => {};
let created: string[] = [];
const commands: string[] = [];

function box(id: string): FakeE2B {
  return {
    sandboxId: id,
    commands: {
      run: async (code: string): Promise<FakeHandle> => {
        commands.push(code);

        return { disconnect: async (): Promise<void> => {} };
      },
    },
  };
}

await mock.module("e2b", () => ({
  Sandbox: {
    create: async (): Promise<FakeE2B> => {
      created.push("fresh");

      return box("fresh");
    },
    connect: (id: string): Promise<FakeE2B> => connectImpl(id),
    kill: (id: string): Promise<void> => killImpl(id),
  },
}));

function config(): SandboxExecutorConfig {
  return {
    provider: "e2b",
    persistent: true,
    controlPlane: {
      accountId: "acct_1",
      name: "box",
      specs: { vcpu: 1, memoryMb: 1024 },
    },
    options: { apiKey: "key" },
  } as SandboxExecutorConfig;
}

// The row write is queued, so it reaches the spy a tick after the launch returns.
async function launch(
  executor: E2BSandboxExecutor,
  extra: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<E2BSandboxExecutor["runBackground"]>>> {
  const handle = await executor.runBackground({
    code: "echo hi",
    reservationKey: KEY,
    timeoutSeconds: 30,
    outputLimitBytes: 1024,
    jobId: "job_1",
    ...extra,
  });
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, 0);
  });

  return handle;
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
  created = [];
  commands.length = 0;
  connectImpl = async (id: string): Promise<FakeE2B> => box(id);
  killImpl = async (): Promise<void> => {};
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

describe("e2b acquire", () => {
  test("reconnects to the stored sandbox", async (): Promise<void> => {
    stored("ext-1");

    const handle = await launch(new E2BSandboxExecutor(config()));

    expect(handle).toEqual({ jobId: "job_1", externalId: "ext-1" });
    expect(created).toHaveLength(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test("recreates a sandbox the provider no longer has", async (): Promise<void> => {
    stored("ext-1");
    connectImpl = async (): Promise<FakeE2B> => {
      throw gone();
    };

    const handle = await launch(new E2BSandboxExecutor(config()));

    expect(handle.externalId).toBe("fresh");
    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test("keeps the stored sandbox on a transient connect error", async (): Promise<void> => {
    stored("ext-1");
    connectImpl = async (): Promise<FakeE2B> => {
      throw new Error("upstream broke");
    };

    await expect(launch(new E2BSandboxExecutor(config()))).rejects.toThrow(
      "upstream broke",
    );
    expect(created).toHaveLength(0);
    expect(removeRow).toHaveBeenCalledTimes(0);
  });

  test("connects to the winner and kills its own sandbox when the claim is lost", async (): Promise<void> => {
    stored(undefined, "winner");
    claim.mockResolvedValue(false);
    const killed: string[] = [];
    killImpl = async (id: string): Promise<void> => {
      killed.push(id);
      throw new Error("already killed");
    };

    const handle = await launch(new E2BSandboxExecutor(config()));

    expect(handle.externalId).toBe("winner");
    expect(killed).toEqual(["fresh"]);
  });

  test("fails when the claim is lost and no winner row exists", async (): Promise<void> => {
    stored(undefined, undefined);
    claim.mockResolvedValue(false);

    await expect(launch(new E2BSandboxExecutor(config()))).rejects.toThrow(
      "lost create race",
    );
  });

  test("undoes both sides when the claim call fails", async (): Promise<void> => {
    stored(undefined);
    claim.mockRejectedValue(new Error("claim exploded"));
    const killed: string[] = [];
    killImpl = async (id: string): Promise<void> => {
      killed.push(id);
    };

    await expect(launch(new E2BSandboxExecutor(config()))).rejects.toThrow(
      "claim exploded",
    );
    expect(killed).toEqual(["fresh"]);
    expect(removeRow).toHaveBeenCalledTimes(1);
  });
});

describe("e2b background jobs", () => {
  test("refuses a sandbox with no reservation", async (): Promise<void> => {
    await expect(
      new E2BSandboxExecutor({
        provider: "e2b",
      } as SandboxExecutorConfig).runBackground({
        code: "x",
        timeoutSeconds: 1,
        outputLimitBytes: 1,
      }),
    ).rejects.toThrow("require a persistent e2b sandbox");
  });

  test("wraps the code so the callback fires after it", async (): Promise<void> => {
    stored("ext-1");

    await launch(new E2BSandboxExecutor(config()), {
      callback: { url: "https://hook.test/cb", token: "tok" },
    });

    expect(commands[0]).toContain("base64 -d");
    expect(commands[0]).toContain("/tmp/fp-e2b-job-job_1.log");
    expect(commands[0]).toContain("https://hook.test/cb");
  });

  test("rejects a job id that is unsafe in a shell", async (): Promise<void> => {
    stored("ext-1");

    await expect(
      launch(new E2BSandboxExecutor(config()), {
        jobId: "a b; rm -rf /",
        callback: { url: "https://hook.test/cb", token: "tok" },
      }),
    ).rejects.toThrow("Invalid job id");
  });
});

describe("e2b release", () => {
  test("ignores a request with no reservation key", async (): Promise<void> => {
    await new E2BSandboxExecutor(config()).release({});
    expect(removeRow).toHaveBeenCalledTimes(0);
  });

  test("ignores a reservation with no stored sandbox", async (): Promise<void> => {
    stored(undefined);
    await new E2BSandboxExecutor(config()).release({ reservationKey: KEY });
    expect(removeRow).toHaveBeenCalledTimes(0);
  });
});
