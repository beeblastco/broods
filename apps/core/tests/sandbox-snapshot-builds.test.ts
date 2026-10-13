import { afterAll, afterEach, expect, it, mock, spyOn } from "bun:test";
import { MicrovmSandboxExecutor } from "../src/harness/sandbox/microvm-executor.ts";
import * as runtimeModule from "../src/shared/convex/runtime.ts";
import * as snapshots from "../src/shared/convex/sandbox-snapshots.ts";

const BUILDING = [
  {
    accountId: "acct_1",
    scope: { projectId: "proj_1", stageId: "stage_dev" },
    name: "scraper",
    provider: "lambda" as const,
    baseImage: "obscura",
    externalImageId: "arn:aws:lambda:eu-west-1:1:microvm-image:snap-done",
  },
  {
    accountId: "acct_1",
    scope: { projectId: "proj_1", stageId: "stage_dev" },
    name: "half",
    provider: "lambda" as const,
    baseImage: "default",
    externalImageId: "arn:aws:lambda:eu-west-1:1:microvm-image:snap-wip",
  },
  {
    accountId: "acct_2",
    scope: "account" as const,
    name: "broken",
    provider: "lambda" as const,
    baseImage: "default",
    externalImageId: "arn:aws:lambda:eu-west-1:1:microvm-image:snap-bad",
  },
];
const restores: Array<() => void> = [];
// Copied before the mock below rewrites the module, so afterAll can put it back.
const realRuntime = { ...runtimeModule };
const queries: unknown[][] = [];
let building: unknown[] = [];

await mock.module("../src/shared/convex/runtime.ts", () => ({
  ...realRuntime,
  runtime: {
    ...realRuntime.runtime,
    query: async (...args: unknown[]): Promise<unknown[]> => {
      queries.push(args);

      return building;
    },
  },
}));

// mock.module is process-wide; restore the real runtime for later test files.
afterAll(async (): Promise<void> => {
  await mock.module(
    "../src/shared/convex/runtime.ts",
    (): typeof runtimeModule => realRuntime,
  );
});

afterEach((): void => {
  for (const restore of restores.splice(0)) restore();
  queries.length = 0;
});

it("marks each landed build active or failed and leaves the rest building", async () => {
  building = BUILDING;
  const status = spyOn(
    MicrovmSandboxExecutor.prototype,
    "snapshotStatus",
  ).mockImplementation(async (image: string) =>
    image.endsWith("snap-done")
      ? "active"
      : image.endsWith("snap-bad")
        ? "build_failed"
        : "building",
  );
  const written: Array<{ name: string; scope: unknown; status?: string }> = [];
  const upsert = spyOn(snapshots, "upsertSandboxSnapshot").mockImplementation(
    async (input): Promise<void> => {
      written.push({
        name: input.name,
        scope: input.scope,
        status: input.status,
      });
    },
  );
  restores.push(
    (): void => status.mockRestore(),
    (): void => upsert.mockRestore(),
  );
  const { refreshBuildingSnapshots } =
    await import("../src/shared/sandbox-snapshot-builds.ts");

  expect(await refreshBuildingSnapshots()).toBe(2);
  expect(queries).toEqual([["listBuildingSandboxSnapshots", {}]]);
  // The stage rides along, so a finished build stays locked to it.
  expect(written).toEqual([
    {
      name: "scraper",
      scope: { projectId: "proj_1", stageId: "stage_dev" },
      status: "active",
    },
    { name: "broken", scope: "account", status: "build_failed" },
  ]);
});

it("keeps a snapshot building when its provider cannot be asked", async () => {
  building = [BUILDING[0]];
  const status = spyOn(
    MicrovmSandboxExecutor.prototype,
    "snapshotStatus",
  ).mockImplementation(async (): Promise<never> => {
    throw new Error("AccessDenied");
  });
  const upsert = spyOn(snapshots, "upsertSandboxSnapshot").mockImplementation(
    async (): Promise<void> => {},
  );
  restores.push(
    (): void => status.mockRestore(),
    (): void => upsert.mockRestore(),
  );
  const { refreshBuildingSnapshots } =
    await import("../src/shared/sandbox-snapshot-builds.ts");

  expect(await refreshBuildingSnapshots()).toBe(0);
  expect(upsert).not.toHaveBeenCalled();
});

it("records the rest of the pass when one status write fails", async () => {
  building = BUILDING;
  const status = spyOn(
    MicrovmSandboxExecutor.prototype,
    "snapshotStatus",
  ).mockImplementation(async (image: string) =>
    image.endsWith("snap-wip") ? "building" : "active",
  );
  const upsert = spyOn(snapshots, "upsertSandboxSnapshot").mockImplementation(
    async (input): Promise<void> => {
      if (input.name === "scraper") throw new Error("convex unavailable");
    },
  );
  restores.push(
    (): void => status.mockRestore(),
    (): void => upsert.mockRestore(),
  );
  const { refreshBuildingSnapshots } =
    await import("../src/shared/sandbox-snapshot-builds.ts");

  expect(await refreshBuildingSnapshots()).toBe(1);
  expect(upsert).toHaveBeenCalledTimes(2);
});
