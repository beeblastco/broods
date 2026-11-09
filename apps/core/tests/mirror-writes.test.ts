import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import { settleOnFakeClock } from "./helpers/fake-clock.ts";

type Landed = [kind: string, rowKey: string, detail: unknown];

const landed: Landed[] = [];
let holds = new Map<string, PromiseWithResolvers<void>>();

// A write to a held row waits until the test releases it, like a slow Convex mutation.
async function arrive(entry: Landed): Promise<void> {
  const hold = holds.get(entry[1]);
  holds.delete(entry[1]);
  if (hold) await hold.promise;
  landed.push(entry);
}

await mock.module("../src/shared/convex/sandbox-instances.ts", () => ({
  upsertSandboxInstance: (
    _controlPlane: unknown,
    _provider: string,
    reservationKey: string,
    externalId: string,
    metadata?: { traceId?: string; taskId?: string },
  ): Promise<void> =>
    arrive([
      "upsert",
      reservationKey,
      {
        externalId: externalId,
        traceId: metadata?.traceId,
        taskId: metadata?.taskId,
      },
    ]),
  removeSandboxInstance: (
    _accountId: string,
    reservationKey: string,
    externalId?: string,
  ): Promise<void> => arrive(["remove", reservationKey, externalId]),
}));

const {
  mirrorQueueStats,
  queueMirrorRemove,
  queueMirrorUpsert,
  queueMirrorWrite,
} = await import("../src/harness/sandbox/mirror-writes.ts");
const { drainInFlight } = await import("../src/shared/in-flight.ts");

const PLANE = {
  accountId: "acct-1",
  name: "box",
  specs: { vcpu: 1, memoryMb: 1024, storageGb: 8 },
};

beforeEach((): void => {
  landed.length = 0;
  holds = new Map();
});

afterEach(async (): Promise<void> => {
  for (const hold of holds.values()) hold.resolve();
  jest.useRealTimers();
  await drainInFlight();
});

describe("mirror write lanes", () => {
  it("lands one row's writes in the order they were queued", async () => {
    const first = hold("row-a");
    void upsert("row-a", "m-1", "t-1");
    void queueMirrorWrite("row-a", {
      kind: "status",
      send: (): Promise<void> => arrive(["status", "row-a", "suspended"]),
    });
    const removed = queueMirrorRemove("acct-1", "row-a", "m-2");
    first.resolve();
    await removed;

    expect(landed.map((entry) => entry[0])).toEqual([
      "upsert",
      "status",
      "remove",
    ]);
  });

  it("keeps one pending upsert per machine and merges run fields the newer lacks", async () => {
    const first = hold("row-a");
    void upsert("row-a", "m-1", "t-1");
    void upsert("row-a", "m-1", "t-2", "task-2");
    void upsert("row-a", "m-1", "t-3");
    const last = upsert("row-a", "m-1", undefined);

    expect(mirrorQueueStats()).toMatchObject({ rows: 1, pending: 1 });
    first.resolve();
    await last;

    expect(landed).toEqual([
      [
        "upsert",
        "row-a",
        { externalId: "m-1", traceId: "t-1", taskId: undefined },
      ],
      [
        "upsert",
        "row-a",
        { externalId: "m-1", traceId: "t-3", taskId: "task-2" },
      ],
    ]);
  });

  it("drops a pending upsert and status for the removed machine, never a burst", async () => {
    const first = hold("row-a");
    void upsert("row-a", "m-0", "t-0");
    const dropped = upsert("row-a", "m-1", "t-1");
    void upsert("row-a", "m-2", "t-2");
    void queueMirrorWrite("row-a", {
      kind: "burst",
      externalId: "m-1",
      send: (): Promise<void> => arrive(["burst", "row-a", "m-1"]),
    });
    const removed = queueMirrorRemove("acct-1", "row-a", "m-1");
    first.resolve();
    await removed;
    await dropped;

    expect(landed.map((entry) => [entry[0], entry[2]])).toEqual([
      ["upsert", { externalId: "m-0", traceId: "t-0", taskId: undefined }],
      ["upsert", { externalId: "m-2", traceId: "t-2", taskId: undefined }],
      ["burst", "m-1"],
      ["remove", "m-1"],
    ]);
  });

  it("queues an upsert after a removal behind it, for a key reserved again", async () => {
    const first = hold("row-a");
    void upsert("row-a", "m-1", "t-1");
    void queueMirrorRemove("acct-1", "row-a");
    const again = upsert("row-a", "m-2", "t-2");
    first.resolve();
    await again;

    expect(landed.map((entry) => entry[0])).toEqual([
      "upsert",
      "remove",
      "upsert",
    ]);
  });

  it("runs two sandboxes of one account side by side", async () => {
    const slowRow = hold("row-a");
    void upsert("row-a", "m-a", "t-a");
    await upsert("row-b", "m-b", "t-b");

    expect(landed.map((entry) => entry[1])).toEqual(["row-b"]);
    slowRow.resolve();
  });

  it("frees a row from a hung write after the timeout, without blocking other rows", async () => {
    jest.useFakeTimers();
    hold("row-a");
    void upsert("row-a", "m-1", "t-1");
    const next = queueMirrorRemove("acct-1", "row-a", "m-1");
    await upsert("row-b", "m-b", "t-b");

    expect(landed.map((entry) => entry[1])).toEqual(["row-b"]);
    await settleOnFakeClock(next);
    expect(landed.map((entry) => entry[0])).toEqual(["upsert", "remove"]);
    expect(mirrorQueueStats().rows).toBe(0);
  });

  it("keeps a row's lane moving when a sender throws before it returns", async () => {
    void queueMirrorWrite("row-a", {
      kind: "status",
      send: (): Promise<void> => {
        throw new Error("sender broke");
      },
    });
    await upsert("row-a", "m-1", "t-1");

    expect(landed.map((entry) => entry[0])).toEqual(["upsert"]);
  });

  it("holds shutdown's drain until every queued write landed", async () => {
    const first = hold("row-a");
    void upsert("row-a", "m-1", "t-1");
    void queueMirrorRemove("acct-1", "row-a", "m-1");
    const drained = drainInFlight();
    first.resolve();
    await drained;

    expect(landed.map((entry) => entry[0])).toEqual(["upsert", "remove"]);
  });
});

function hold(rowKey: string): PromiseWithResolvers<void> {
  const held = Promise.withResolvers<void>();
  holds.set(rowKey, held);

  return held;
}

function upsert(
  rowKey: string,
  externalId: string,
  traceId: string | undefined,
  taskId?: string,
): Promise<void> {
  return queueMirrorUpsert({
    controlPlane: PLANE,
    provider: "cloudflare",
    reservationKey: rowKey,
    externalId: externalId,
    metadata: { traceId: traceId, taskId: taskId },
  });
}
