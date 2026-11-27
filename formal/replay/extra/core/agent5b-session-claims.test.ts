import { afterEach, describe, expect, mock, test } from "bun:test";

const calls: { name: string; args: unknown }[] = [];
let claimAnswer = true;

const actualRuntime =
  await import("../../../../apps/core/src/shared/convex/runtime.ts");
await mock.module("../../../../apps/core/src/shared/convex/runtime.ts", () => ({
  ...actualRuntime,
  runtime: {
    ...actualRuntime.runtime,
    mutate: async (name: string, args: unknown): Promise<boolean | null> => {
      calls.push({ name: name, args: args });

      return name === "claimEvent" ? claimAnswer : null;
    },
  },
}));

const { Session } =
  await import("../../../../apps/core/src/harness/session.ts");

afterEach((): void => {
  calls.length = 0;
  claimAnswer = true;
});

describe("Session claims", (): void => {
  const owned = new Session({
    eventId: "acct:a:agent:b:api:event",
    conversationKey: "acct:a:agent:b:api:conv",
    accountId: "a",
    agentId: "b",
  });
  const anonymous = new Session({
    eventId: "event",
    conversationKey: "conv",
  });

  test.each([[true], [false]])(
    "claimMessageTurn answers %p",
    async (answer: boolean): Promise<void> => {
      claimAnswer = answer;

      expect(await owned.claimMessageTurn(40)).toBe(answer);
      expect(calls[0]?.name).toBe("claimEvent");
    },
  );

  test("releaseMessageTurn gives the turn back", async (): Promise<void> => {
    await owned.releaseMessageTurn();

    expect(calls[0]?.name).toBe("releaseClaim");
  });

  test("release gives the event claim back", async (): Promise<void> => {
    await owned.release();

    expect(calls[0]?.args).toEqual({
      accountId: "a",
      key: "acct:a:agent:b:api:event",
    });
  });

  test("claims need an account", async (): Promise<void> => {
    const refused = "Account ID is required for runtime claims";

    expect(anonymous.claimMessageTurn(40)).rejects.toThrow(refused);
    expect(anonymous.releaseMessageTurn()).rejects.toThrow(refused);
    expect(anonymous.release()).rejects.toThrow(refused);
  });

  test("appendIngressEvents stores what is not ephemeral", async (): Promise<void> => {
    const session = new Session({
      eventId: "event",
      conversationKey: "conv",
      persist: false,
    });

    expect(await session.appendIngressEvents([])).toEqual([]);
  });
});
