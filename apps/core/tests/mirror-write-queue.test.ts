import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as instanceStore from "../src/harness/sandbox/instance-store.ts";
import { releasePlatformSandbox } from "../src/harness/sandbox/platform-worker.ts";
import { queueMirrorWrite } from "../src/harness/sandbox/utils.ts";

function gate(): { wait: () => Promise<void>; open: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve): void => {
    open = resolve;
  });

  return { wait: (): Promise<void> => opened, open: open };
}

afterEach((): void => {
  mock.restore();
});

describe("queueMirrorWrite", () => {
  it("runs one account's writes one at a time, across sandboxes", async () => {
    const order: string[] = [];
    const held = gate();
    const first = queueMirrorWrite(
      "acct-a",
      "sbx-1",
      async (): Promise<void> => {
        order.push("start 1");
        await held.wait();
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
    held.open();
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
    const held = gate();
    const first = queueMirrorWrite(
      undefined,
      "sbx-own-1",
      async (): Promise<void> => {
        await held.wait();
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
    held.open();
    await Promise.all([first, same]);

    expect(order).toEqual(["sbx-own-2", "sbx-own-1 first", "sbx-own-1 second"]);
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
    const sameAccount = gate();
    const otherAccount = gate();
    void queueMirrorWrite("acct-r", "sbx-other", async (): Promise<void> => {
      await sameAccount.wait();
      order.push("acct-r write");
    });
    void queueMirrorWrite("acct-x", "sbx-x", (): Promise<void> =>
      otherAccount.wait(),
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

    sameAccount.open();
    await released;
    // Another account's pending write never held the release.
    expect(order).toEqual(["drop sbx-r", "acct-r write", "delete key-r"]);
    otherAccount.open();
  });
});
