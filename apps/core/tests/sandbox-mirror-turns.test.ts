// Mirror writes meter into the account's usage rows: one account's take turns, and a sandbox's
// waiting row refreshes merge into the newest.

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import {
  queueMirrorRefresh,
  queueMirrorWrite,
} from "../src/harness/sandbox/utils.ts";
import { resetConvexClientForTests } from "../src/shared/convex/client.ts";
import {
  recordSandboxBurst,
  removeSandboxInstance,
  setSandboxInstanceSpecs,
  setSandboxInstanceStatus,
  upsertSandboxInstance,
} from "../src/shared/convex/sandbox-instances.ts";
import type { SandboxControlPlane } from "../src/shared/sandbox-sizes.ts";

const savedEnv = { ...process.env };

interface Held {
  path: string;
  accountId: string;
  release: (response: Response) => void;
}

let held: Held[] = [];
let arrived: () => void = () => {};
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach((): void => {
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_DEPLOY_KEY = "dev:test|key";
  resetConvexClientForTests();
  held = [];
  // Every Convex call waits until the test answers it.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const call = JSON.parse(init?.body as string) as {
          path: string;
          args: [{ accountId: string }];
        };
        const answer = Promise.withResolvers<Response>();
        held.push({
          path: call.path,
          accountId: call.args[0].accountId,
          release: answer.resolve,
        });
        arrived();

        return answer.promise;
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});

afterEach((): void => {
  fetchSpy.mockRestore();
  process.env = { ...savedEnv };
  resetConvexClientForTests();
});

function plane(accountId: string): SandboxControlPlane {
  return {
    accountId: accountId,
    name: "box",
    specs: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
  };
}

async function heldCount(count: number): Promise<void> {
  while (held.length < count) {
    const next = Promise.withResolvers<void>();
    arrived = next.resolve;
    await next.promise;
  }
  await Bun.sleep(5);
}

function ok(value: unknown = null): Response {
  return Response.json({ status: "success", value: value });
}

it("sends one account's writes one at a time, in order", async (): Promise<void> => {
  const first = upsertSandboxInstance(plane("acct_1"), "cloudflare", "a", "a");
  const second = upsertSandboxInstance(plane("acct_1"), "cloudflare", "b", "b");
  await heldCount(1);
  expect(held).toHaveLength(1);
  held[0]!.release(ok());
  await heldCount(2);
  expect(held).toHaveLength(2);
  held[1]!.release(ok());
  await Promise.all([first, second]);
  expect(held.map((call) => call.path)).toEqual([
    "sandbox/instances:upsert",
    "sandbox/instances:upsert",
  ]);
});

it("lets different accounts write at once", async (): Promise<void> => {
  const first = upsertSandboxInstance(plane("acct_1"), "cloudflare", "a", "a");
  const second = upsertSandboxInstance(plane("acct_2"), "cloudflare", "b", "b");
  await heldCount(2);
  expect(held.map((call) => call.accountId).sort()).toEqual([
    "acct_1",
    "acct_2",
  ]);
  for (const call of held) call.release(ok());
  await Promise.all([first, second]);
});

it("puts status, size, burst and remove writes in the same line", async (): Promise<void> => {
  const writes = [
    upsertSandboxInstance(plane("acct_1"), "cloudflare", "a", "a"),
    setSandboxInstanceStatus("acct_1", "a", "suspended"),
    setSandboxInstanceSpecs("acct_1", "a", "a", {
      vcpu: 1,
      memoryMb: 2048,
      storageGb: 8,
    }),
    recordSandboxBurst("acct_1", "a", { vcpuSeconds: 1, gbSeconds: 1 }),
    removeSandboxInstance("acct_1", "a", "a"),
  ];
  for (let index = 0; index < writes.length; index += 1) {
    await heldCount(index + 1);
    expect(held).toHaveLength(index + 1);
    held[index]!.release(ok(index === 1 || index === 3 ? true : null));
  }
  await Promise.all(writes);
  expect(held.map((call) => call.path)).toEqual([
    "sandbox/instances:upsert",
    "sandbox/instances:setStatus",
    "sandbox/instances:setSpecs",
    "sandbox/instances:recordBurst",
    "sandbox/instances:remove",
  ]);
  expect(await writes[1]).toBe(true);
  expect(await writes[3]).toBe(true);
});

it("moves on after a failed write and still logs it", async (): Promise<void> => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const failed = upsertSandboxInstance(
      plane("acct_1"),
      "cloudflare",
      "a",
      "a",
    );
    const next = setSandboxInstanceStatus("acct_1", "b", "running");
    await heldCount(1);
    held[0]!.release(
      Response.json(
        { status: "error", errorMessage: "conflict on usageDays" },
        { status: 560 },
      ),
    );
    await heldCount(2);
    held[1]!.release(ok(true));
    await failed;
    expect(await next).toBe(true);
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
});

it("writes nothing without a control plane", async (): Promise<void> => {
  await upsertSandboxInstance(undefined, "cloudflare", "a", "a");
  await Bun.sleep(5);
  expect(held).toHaveLength(0);
});

it("merges a sandbox's waiting refreshes into the newest", async (): Promise<void> => {
  const ran: string[] = [];
  const busy = Promise.withResolvers<void>();
  const first = queueMirrorRefresh("sbx_merge", async (): Promise<void> => {
    ran.push("first");
    await busy.promise;
  });
  await Bun.sleep(0);
  const second = queueMirrorRefresh("sbx_merge", async (): Promise<void> => {
    ran.push("second");
  });
  const third = queueMirrorRefresh("sbx_merge", async (): Promise<void> => {
    ran.push("third");
  });
  busy.resolve();
  await Promise.all([first, second, third]);
  expect(ran).toEqual(["first", "third"]);
});

it("never moves a refresh ahead of a write queued after it", async (): Promise<void> => {
  const ran: string[] = [];
  const busy = Promise.withResolvers<void>();
  void queueMirrorRefresh("sbx_order", async (): Promise<void> => {
    ran.push("first");
    await busy.promise;
  });
  await Bun.sleep(0);
  void queueMirrorRefresh("sbx_order", async (): Promise<void> => {
    ran.push("second");
  });
  void queueMirrorWrite("sbx_order", async (): Promise<void> => {
    ran.push("remove");
  });
  const last = queueMirrorRefresh("sbx_order", async (): Promise<void> => {
    ran.push("third");
  });
  busy.resolve();
  await last;
  expect(ran).toEqual(["first", "second", "remove", "third"]);
});

it("queues a new refresh once the waiting one has started", async (): Promise<void> => {
  const ran: string[] = [];
  const busy = Promise.withResolvers<void>();
  const first = queueMirrorRefresh("sbx_start", async (): Promise<void> => {
    ran.push("first");
    await busy.promise;
  });
  await Bun.sleep(0);
  const second = queueMirrorRefresh("sbx_start", async (): Promise<void> => {
    ran.push("second");
  });
  busy.resolve();
  await Promise.all([first, second]);
  await queueMirrorRefresh("sbx_start", async (): Promise<void> => {
    ran.push("third");
  });
  expect(ran).toEqual(["first", "second", "third"]);
});
