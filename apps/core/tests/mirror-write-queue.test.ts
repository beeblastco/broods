import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import { releasePlatformSandbox } from "../src/harness/sandbox/platform-worker.ts";
import { queueMirrorWrite } from "../src/harness/sandbox/utils.ts";
import { drainInFlight } from "../src/shared/in-flight.ts";

afterEach((): void => {
  mock.restore();
});

describe("queueMirrorWrite", () => {
  it("runs one account's writes one at a time, across sandboxes", async () => {
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    const first = queueMirrorWrite(
      "acct-a",
      "sbx-1",
      async (): Promise<void> => {
        order.push("start 1");
        await held.promise;
        order.push("end 1");
      },
    );
    const second = queueMirrorWrite(
      "acct-a",
      "sbx-2",
      async (): Promise<void> => {
        order.push("start 2");
      },
    );
    const other = queueMirrorWrite(
      "acct-b",
      "sbx-3",
      async (): Promise<void> => {
        order.push("other account");
      },
    );
    await other;
    held.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(["start 1", "other account", "end 1", "start 2"]);
  });

  it("keeps the queue going after a write fails", async () => {
    const failed = queueMirrorWrite(
      "acct-c",
      "sbx-1",
      async (): Promise<void> => {
        throw new Error("conflict");
      },
    );
    let ran = false;
    await queueMirrorWrite("acct-c", "sbx-2", async (): Promise<void> => {
      ran = true;
    });

    await expect(failed).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("queues a write with no account on its sandbox id", async () => {
    const order: string[] = [];
    const held = Promise.withResolvers<void>();
    const first = queueMirrorWrite(
      undefined,
      "sbx-own-1",
      async (): Promise<void> => {
        await held.promise;
        order.push("sbx-own-1 first");
      },
    );
    const same = queueMirrorWrite(
      undefined,
      "sbx-own-1",
      async (): Promise<void> => {
        order.push("sbx-own-1 second");
      },
    );
    await queueMirrorWrite(undefined, "sbx-own-2", async (): Promise<void> => {
      order.push("sbx-own-2");
    });
    held.resolve();
    await Promise.all([first, same]);

    expect(order).toEqual(["sbx-own-2", "sbx-own-1 first", "sbx-own-1 second"]);
  });

  it("holds shutdown until a write nobody awaits lands", async () => {
    const held = Promise.withResolvers<void>();
    let landed = false;
    void queueMirrorWrite("acct-s", "sbx-1", async (): Promise<void> => {
      await held.promise;
      landed = true;
    });
    const drained = drainInFlight().then((): boolean => landed);
    held.resolve();

    expect(await drained).toBe(true);
  });
});

describe("releasePlatformSandbox", () => {
  it("drops the reservation only after the account's queued writes land", async () => {
    const order: string[] = [];
    spyOn(instanceStore, "deleteSandboxInstance").mockImplementation(
      async (_provider, key): Promise<boolean> => {
        order.push(`delete ${key}`);

        return true;
      },
    );
    const sameAccount = Promise.withResolvers<void>();
    const otherAccount = Promise.withResolvers<void>();
    void queueMirrorWrite("acct-r", "sbx-other", async (): Promise<void> => {
      await sameAccount.promise;
      order.push("acct-r write");
    });
    void queueMirrorWrite(
      "acct-x",
      "sbx-x",
      (): Promise<void> => otherAccount.promise,
    );

    const released = releasePlatformSandbox(
      "worker",
      "acct-r",
      { reservationKey: "key-r", expectedExternalId: "sbx-r" },
      async (id): Promise<void> => {
        order.push(`drop ${id}`);
      },
    );
    await Bun.sleep(0);
    expect(order).toEqual(["drop sbx-r"]);

    sameAccount.resolve();
    await released;
    // Another account's pending write never held the release.
    expect(order).toEqual(["drop sbx-r", "acct-r write", "delete key-r"]);
    otherAccount.resolve();
  });
});
