import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  setSystemTime,
} from "bun:test";
import { settleOnFakeClock } from "./helpers/fake-clock.ts";

type Landed = [kind: string, rowKey: string, detail: unknown];
const landed: Landed[] = [];
let holds = new Map<string, PromiseWithResolvers<void>>();
let inFlight = 0;
let peak = 0;
let testsRun = 0;
let failUpserts = 0;

async function arrive(entry: Landed): Promise<void> {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  const hold = holds.get(entry[1]);
  holds.delete(entry[1]);
  if (hold) await hold.promise;
  else await Promise.resolve();
  inFlight -= 1;
  landed.push(entry);
}

await mock.module("../src/shared/convex/sandbox-instances.ts", () => ({
  upsertSandboxInstance: async (
    _c: unknown,
    _p: string,
    key: string,
    externalId: string,
    metadata?: { traceId?: string; taskId?: string },
  ): Promise<boolean> => {
    if (failUpserts > 0) {
      failUpserts -= 1;

      return false;
    }
    await arrive([
      "upsert",
      key,
      {
        externalId: externalId,
        traceId: metadata?.traceId,
        taskId: metadata?.taskId,
      },
    ]);

    return true;
  },
  removeSandboxInstance: (
    _a: string,
    key: string,
    externalId?: string,
  ): Promise<void> => arrive(["remove", key, externalId]),
}));
const {
  mirrorQueueStats,
  queueMirrorRemove,
  queueMirrorUpsert,
  queueMirrorWrite,
} = await import("../src/harness/sandbox/mirror-writes.ts");
const { drainInFlight } = await import("../src/shared/in-flight.ts");

const plane = (accountId: string) => ({
  accountId: accountId,
  name: "box",
  specs: { vcpu: 1, memoryMb: 1024, storageGb: 8 },
});
const kinds = (): string[] => landed.map((entry) => entry[0] + ":" + entry[1]);

beforeEach((): void => {
  // The queue remembers each row's last refresh for a minute: every test starts past it.
  testsRun += 1;
  setSystemTime(new Date(Date.now() + testsRun * 120_000));
  landed.length = 0;
  holds = new Map();
  failUpserts = 0;
  inFlight = 0;
  peak = 0;
});
afterEach(async (): Promise<void> => {
  for (const h of holds.values()) h.resolve();
  jest.useRealTimers();
  setSystemTime();
  await drainInFlight();
});

describe("mirror writes", () => {
  it("lands one row's writes in the order queued, a suspend included", async () => {
    const first = hold("row-a");
    void upsert("acct", "row-a", "m-1", "t-1");
    void status("acct", "row-a", "suspended");
    void upsert("acct", "row-a", "m-1", "t-2");
    void status("acct", "row-a", "running");
    const removed = queueMirrorRemove("acct", "row-a", "m-1");
    first.resolve();
    await removed;
    expect(
      landed.map((e) => (e[0] === "status" ? "status:" + String(e[2]) : e[0])),
    ).toEqual([
      "upsert",
      "status:suspended",
      "upsert",
      "status:running",
      "remove",
    ]);
  });

  it("keeps the latest of consecutive upserts and the run fields it lacks", async () => {
    const first = hold("row-a");
    void upsert("acct", "row-a", "m-1", "t-1");
    void upsert("acct", "row-a", "m-1", "t-2", "task-2");
    void upsert("acct", "row-a", "m-1", "t-3");
    const last = upsert("acct", "row-a", "m-1", undefined);
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

  it("sends an unchanged refresh once a minute, and at once when the row changed", async () => {
    const start = Date.now();
    const refresh = (traceId = "t-1"): Promise<void> =>
      upsert("acct", "row-a", "m-1", traceId);
    await refresh();
    await refresh();
    setSystemTime(new Date(start + 59_000));
    await refresh();
    expect(landed).toHaveLength(1);

    await refresh("t-2");
    await status("acct", "row-a", "suspended");
    await refresh("t-2");
    setSystemTime(new Date(start + 120_000));
    await refresh("t-2");
    expect(kinds()).toEqual([
      "upsert:row-a",
      "upsert:row-a",
      "status:row-a",
      "upsert:row-a",
      "upsert:row-a",
    ]);
    await queueMirrorRemove("acct", "row-a", "m-1");
    await refresh("t-2");
    expect(landed).toHaveLength(7);
  });

  it("sends an unchanged refresh again when the last one failed or timed out", async () => {
    failUpserts = 1;
    await upsert("acct", "row-a", "m-1", "t-1");
    await upsert("acct", "row-a", "m-1", "t-1");
    expect(kinds()).toEqual(["upsert:row-a"]);

    jest.useFakeTimers();
    hold("row-b");
    await settleOnFakeClock(upsert("acct", "row-b", "m-2", "t-1"));
    await upsert("acct", "row-b", "m-2", "t-1");
    expect(kinds()).toEqual(["upsert:row-a", "upsert:row-b"]);
  });

  it("keeps the refresh window a fifteenth of a short idle timeout", async () => {
    const start = Date.now();
    const refresh = (): Promise<void> =>
      queueMirrorUpsert({
        controlPlane: { ...plane("acct"), idleTimeoutSeconds: 30 },
        provider: "cloudflare",
        reservationKey: "row-a",
        externalId: "m-1",
      });
    await refresh();
    setSystemTime(new Date(start + 1_900));
    await refresh();
    setSystemTime(new Date(start + 2_000));
    await refresh();
    expect(landed).toHaveLength(2);
  });

  it("sends one account's rows one at a time, in turn", async () => {
    const writes = [];
    for (let round = 0; round < 3; round++)
      for (const row of ["r1", "r2", "r3"])
        writes.push(upsert("acct", row, "m-" + row, "t" + round));
    await Promise.all(writes);
    expect(peak).toBe(1);
    expect(kinds()).toEqual([
      "upsert:r1",
      "upsert:r2",
      "upsert:r3",
      "upsert:r1",
    ]);
  });

  it("sends two accounts side by side", async () => {
    const slow = hold("row-a");
    void upsert("acct-1", "row-a", "m-a", "t");
    await upsert("acct-2", "row-b", "m-b", "t");
    expect(kinds()).toEqual(["upsert:row-b"]);
    slow.resolve();
  });

  it("sends a removal ahead of other rows' refreshes", async () => {
    const first = hold("r0");
    void upsert("acct", "r0", "m0", "t");
    for (let i = 1; i <= 50; i++) void upsert("acct", "r" + i, "m" + i, "t");
    const removed = queueMirrorRemove("acct", "r40", "m40");
    first.resolve();
    await removed;
    expect(kinds()).toEqual(["upsert:r0", "upsert:r40", "remove:r40"]);
  });

  it("frees the account from a hung write after the timeout, and never blocks another account", async () => {
    jest.useFakeTimers();
    hold("row-a");
    void upsert("acct-1", "row-a", "m-1", "t-1");
    const next = queueMirrorRemove("acct-1", "row-b", "m-b");
    await upsert("acct-2", "row-c", "m-c", "t");
    expect(kinds()).toEqual(["upsert:row-c"]);
    await settleOnFakeClock(next);
    expect(kinds()).toEqual(["upsert:row-c", "remove:row-b"]);
    expect(mirrorQueueStats().rows).toBe(0);
  });

  it("keeps sending when a sender throws before it returns", async () => {
    void queueMirrorWrite("acct", "row-a", {
      kind: "status",
      send: (): Promise<void> => {
        throw new Error("sender broke");
      },
    });
    await upsert("acct", "row-a", "m-1", "t-1");
    expect(kinds()).toEqual(["upsert:row-a"]);
  });

  it("holds shutdown's drain until every queued write landed", async () => {
    const first = hold("row-a");
    void upsert("acct", "row-a", "m-1", "t-1");
    void queueMirrorRemove("acct", "row-b", "m-2");
    const drained = drainInFlight();
    first.resolve();
    await drained;
    expect(kinds()).toEqual(["upsert:row-a", "remove:row-b"]);
  });
});

function hold(rowKey: string): PromiseWithResolvers<void> {
  const held = Promise.withResolvers<void>();
  holds.set(rowKey, held);
  return held;
}
function status(
  accountId: string,
  rowKey: string,
  value: string,
): Promise<void> {
  return queueMirrorWrite(accountId, rowKey, {
    kind: "status",
    send: (): Promise<void> => arrive(["status", rowKey, value]),
  });
}
function upsert(
  accountId: string,
  rowKey: string,
  externalId: string,
  traceId: string | undefined,
  taskId?: string,
): Promise<void> {
  return queueMirrorUpsert({
    controlPlane: plane(accountId),
    provider: "cloudflare",
    reservationKey: rowKey,
    externalId: externalId,
    metadata: { traceId: traceId, taskId: taskId },
  });
}
