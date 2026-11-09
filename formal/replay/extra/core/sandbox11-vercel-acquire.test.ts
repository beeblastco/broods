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
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import { VercelSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/vercel-executor.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";

interface FakeSnapshot {
  status: string;
  snapshotId: string;
}

interface FakeSandbox {
  name: string;
  createdAt: Date;
  networkId?: string;
  deleted: number;
  deleteFails: boolean;
  snapshotResult: FakeSnapshot;
  update: (input: unknown) => Promise<void>;
  delete: () => Promise<void>;
  snapshot: (input: unknown) => Promise<FakeSnapshot>;
}

type Spy = { mockRestore: () => void };
type Getter = (input: { name: string }) => Promise<FakeSandbox>;

const KEY = "fs-0123456789abcdef0123456789abcdef01234567";
let spies: Spy[] = [];
let created: FakeSandbox[] = [];
let getter: Getter = async (): Promise<FakeSandbox> => fakeSandbox("unused");
let createCalls: unknown[] = [];

function fakeSandbox(name: string, ageMs = 0): FakeSandbox {
  const box: FakeSandbox = {
    name: name,
    createdAt: new Date(Date.now() - ageMs),
    deleted: 0,
    deleteFails: false,
    snapshotResult: { status: "created", snapshotId: "snap_1" },
    update: async (): Promise<void> => {},
    delete: async (): Promise<void> => {
      box.deleted += 1;
      if (box.deleteFails) throw new Error("delete refused");
    },
    snapshot: async (): Promise<FakeSnapshot> => box.snapshotResult,
  };

  return box;
}

await mock.module("@vercel/sandbox", () => ({
  Sandbox: {
    create: async (input: unknown): Promise<FakeSandbox> => {
      createCalls.push(input);
      const box = fakeSandbox((input as { name?: string }).name ?? "fresh");
      created.push(box);

      return box;
    },
    get: (input: { name: string }): Promise<FakeSandbox> => getter(input),
  },
}));

function config(lifecycle?: {
  maxLifetimeSeconds: number;
}): SandboxExecutorConfig {
  return {
    provider: "vercel",
    persistent: true,
    ...(lifecycle ? { lifecycle: lifecycle } : {}),
    options: { token: "tok", teamId: "team_1", projectId: "prj_1" },
  } as SandboxExecutorConfig;
}

function stored(...names: Array<string | undefined>): void {
  const spy = spyOn(instanceStore, "getSandboxExternalId");
  for (const name of names) spy.mockResolvedValueOnce(name as string);
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
  createCalls = [];
  getter = async (): Promise<FakeSandbox> => fakeSandbox("unused");
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

async function warm(executor: VercelSandboxExecutor): Promise<void> {
  await executor.prewarm({ reservationKey: KEY });
}

describe("vercel acquire", () => {
  test("recreates a stored sandbox the provider no longer has", async (): Promise<void> => {
    stored("old-box");
    getter = async (): Promise<FakeSandbox> => {
      throw gone();
    };

    await warm(new VercelSandboxExecutor(config()));

    expect(removeRow).toHaveBeenCalledTimes(1);
    expect(createCalls).toHaveLength(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test("does not recreate after a transient lookup error", async (): Promise<void> => {
    stored("old-box");
    getter = async (): Promise<FakeSandbox> => {
      throw Object.assign(new Error("upstream broke"), { statusCode: 500 });
    };

    await expect(warm(new VercelSandboxExecutor(config()))).rejects.toThrow();
    expect(createCalls).toHaveLength(0);
    expect(removeRow).toHaveBeenCalledTimes(0);
  });

  test("retires a sandbox past its max lifetime and starts a new one", async (): Promise<void> => {
    stored("old-box");
    const old = fakeSandbox("old-box", 3_600_000);
    getter = async (): Promise<FakeSandbox> => old;

    await warm(new VercelSandboxExecutor(config({ maxLifetimeSeconds: 60 })));

    expect(old.deleted).toBe(1);
    expect(removeRow).toHaveBeenCalledTimes(1);
    expect(createCalls).toHaveLength(1);
  });

  test("hands back the winner when the claim is lost", async (): Promise<void> => {
    stored(undefined, "winner-box");
    claim.mockResolvedValue(false);
    const names: string[] = [];
    getter = async (input: { name: string }): Promise<FakeSandbox> => {
      names.push(input.name);

      return fakeSandbox(input.name);
    };

    await warm(new VercelSandboxExecutor(config()));

    expect(created).toHaveLength(1);
    expect(created[0]?.deleted).toBe(1);
    expect(names).toEqual(["winner-box"]);
    expect(upsert).toHaveBeenCalledTimes(0);
  });

  test("keeps its own sandbox when the winning row vanished", async (): Promise<void> => {
    stored(undefined, undefined);
    claim.mockResolvedValue(false);

    await warm(new VercelSandboxExecutor(config()));

    expect(created[0]?.deleted).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test("cleans up and rethrows when the claim call fails", async (): Promise<void> => {
    stored(undefined);
    claim.mockRejectedValue(new Error("claim exploded"));
    removeRow.mockRejectedValue(new Error("row gone"));

    await expect(warm(new VercelSandboxExecutor(config()))).rejects.toThrow(
      "claim exploded",
    );
    expect(created[0]?.deleted).toBe(1);
    expect(removeRow).toHaveBeenCalledTimes(1);
  });
});

describe("vercel release", () => {
  const executor = (): VercelSandboxExecutor =>
    new VercelSandboxExecutor(config());

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
    getter = async (): Promise<FakeSandbox> => {
      throw gone();
    };
    removeRow.mockRejectedValue(new Error("row gone"));

    await executor().release({ reservationKey: KEY, expectedExternalId: "x" });

    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test("rethrows a release failure that is not a gone sandbox", async (): Promise<void> => {
    getter = async (): Promise<FakeSandbox> => {
      throw new Error("boom");
    };

    await expect(
      executor().release({ reservationKey: KEY, expectedExternalId: "x" }),
    ).rejects.toThrow("boom");
    expect(removeRow).toHaveBeenCalledTimes(0);
  });
});

describe("vercel snapshot", () => {
  test("rejects a snapshot that did not finish", async (): Promise<void> => {
    stored("box");
    const box = fakeSandbox("box");
    box.snapshotResult = { status: "failed", snapshotId: "snap_9" };
    getter = async (): Promise<FakeSandbox> => box;

    await expect(
      new VercelSandboxExecutor(config()).snapshot({ reservationKey: KEY }),
    ).rejects.toThrow("snap_9 ended failed");
  });
});

describe("vercel auth", () => {
  test("names every missing credential", async (): Promise<void> => {
    const bare = {
      provider: "vercel",
      persistent: true,
      options: {},
    } as SandboxExecutorConfig;
    const saved = [
      process.env.VERCEL_TOKEN,
      process.env.VERCEL_TEAM_ID,
      process.env.VERCEL_PROJECT_ID,
    ];
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    stored("box");
    try {
      await expect(warm(new VercelSandboxExecutor(bare))).rejects.toThrow(
        "missing token, teamId, projectId",
      );
    } finally {
      const [token, teamId, projectId] = saved;
      if (token !== undefined) process.env.VERCEL_TOKEN = token;
      if (teamId !== undefined) process.env.VERCEL_TEAM_ID = teamId;
      if (projectId !== undefined) process.env.VERCEL_PROJECT_ID = projectId;
    }
  });
});
