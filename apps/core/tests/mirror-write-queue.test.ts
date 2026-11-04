import { describe, expect, it } from "bun:test";
import { queueMirrorWrite } from "../src/harness/sandbox/utils.ts";

describe("queueMirrorWrite", () => {
  it("runs one account's writes one at a time, across sandboxes", async () => {
    const order: string[] = [];
    let release = (): void => {};
    const first = queueMirrorWrite(
      "acct-a",
      "sbx-1",
      async (): Promise<void> => {
        order.push("start 1");
        await new Promise<void>((resolve): void => {
          release = resolve;
        });
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
    release();
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
});
