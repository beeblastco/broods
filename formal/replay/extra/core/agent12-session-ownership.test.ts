import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { Session } from "../../../../apps/core/src/harness/session.ts";
import { openRunToken } from "../../../../apps/core/src/shared/run-token.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";

const KEY = "acct:acct_1:agent:agent_1:api:chat";

function session(ownerGeneration?: number): Session {
  return new Session({
    eventId: "event_1",
    conversationKey: KEY,
    accountId: "acct_1",
    agentId: "agent_1",
    ...(ownerGeneration === undefined
      ? {}
      : { ownerGeneration: ownerGeneration }),
  });
}

afterEach((): void => {
  spyOn(runtime, "mutate").mockRestore();
  setSystemTime();
  delete process.env.PUBLIC_BASE_URL;
});

describe("renewConversationLease", (): void => {
  test("a session with no owner generation has nothing to renew", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue("stale");

    expect(await session().renewConversationLease()).toBe("renewed");
    expect(mutate).not.toHaveBeenCalled();
  });

  test("the lease is renewed under the owner's generation, and a renewal confirms ownership", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue("renewed");
    const owned = session(4);

    expect(await owned.renewConversationLease()).toBe("renewed");
    expect(mutate).toHaveBeenCalledWith("renewIngressOwner", {
      conversationKey: KEY,
      ownerEventId: "event_1",
      ownerGeneration: 4,
      leaseTtlMs: 15 * 60 * 1000,
    });
    await expect(owned.assertRecentOwner()).resolves.toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  test.each(["stopped", "stale"] as const)(
    "a %s answer is passed back and confirms nothing",
    async (answer): Promise<void> => {
      const mutate = spyOn(runtime, "mutate").mockResolvedValue(answer);
      spyOn(runtime, "query").mockResolvedValue(true);
      const owned = session(4);

      expect(await owned.renewConversationLease()).toBe(answer);
      await owned.assertRecentOwner();
      // oxlint-disable-next-line typescript/unbound-method -- a mock, never called with this
      expect(runtime.query).toHaveBeenCalledWith("isCurrentIngressOwner", {
        conversationKey: KEY,
        ownerEventId: "event_1",
        ownerGeneration: 4,
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      spyOn(runtime, "query").mockRestore();
    },
  );
});

describe("applySteeringIngress", (): void => {
  test("a session with no owner generation has no steering", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue({});

    expect(await session().applySteeringIngress()).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  test("steering is claimed under the owner's generation, text-only when asked", async (): Promise<void> => {
    const applied = { eventId: "steer_1", events: [] };
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(applied);
    const owned = session(2);

    expect(await owned.applySteeringIngress()).toBe(applied);
    expect(await owned.applySteeringIngress({ textOnly: true })).toBe(applied);

    expect(mutate.mock.calls.map((call): unknown => call[1])).toEqual([
      {
        conversationKey: KEY,
        ownerEventId: "event_1",
        ownerGeneration: 2,
        leaseTtlMs: 15 * 60 * 1000,
      },
      {
        conversationKey: KEY,
        ownerEventId: "event_1",
        ownerGeneration: 2,
        textOnly: true,
        leaseTtlMs: 15 * 60 * 1000,
      },
    ]);
  });

  test("no steering waiting is a null that still confirms ownership", async (): Promise<void> => {
    spyOn(runtime, "mutate").mockResolvedValue(null);
    const owned = session(2);

    expect(await owned.applySteeringIngress()).toBeNull();
    await owned.assertRecentOwner();
    // oxlint-disable-next-line typescript/unbound-method -- a mock, never called with this
    expect(runtime.mutate).toHaveBeenCalledTimes(1);
  });
});

describe("sandboxPrincipal", (): void => {
  function withPrincipal(principal?: {
    kind: "agent";
    accountId: string;
    agentId: string;
  }): Session {
    return new Session({
      eventId: "event_1",
      conversationKey: KEY,
      accountId: "acct_1",
      agentId: "agent_1",
      ...(principal ? { principal: principal } : {}),
    });
  }

  test("a session with no principal sends none", (): void => {
    expect(withPrincipal().sandboxPrincipal()).toBeUndefined();
  });

  test("a principal gets a run token for its own account and agent, and the public base URL when one is set", (): void => {
    process.env.STAGE_TICKET_SECRET ||= "ticket-secret-for-tests";
    setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    const owner = {
      kind: "agent",
      accountId: "acct_1",
      agentId: "agent_1",
    } as const;

    const plain = withPrincipal(owner).sandboxPrincipal();
    process.env.PUBLIC_BASE_URL = "https://api.example.test//";
    const routed = withPrincipal(owner).sandboxPrincipal();

    expect(plain).toMatchObject({ accountId: "acct_1", agentId: "agent_1" });
    expect(plain).not.toHaveProperty("baseUrl");
    expect(openRunToken(plain!.runToken)).toEqual({
      accountId: "acct_1",
      agentId: "agent_1",
    });
    expect(routed?.baseUrl).toBe("https://api.example.test");
    expect(routed?.runToken).toBe(plain?.runToken);
  });
});
