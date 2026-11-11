import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ModelMessage } from "ai";

import {
  createStoredEventFromModelMessage,
  Session,
} from "../../../../apps/core/src/harness/session.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";

const KEY = "acct:acct_1:agent:agent_1:api:chat";

afterEach((): void => {
  spyOn(runtime, "mutate").mockRestore();
});

describe("Session.claim", (): void => {
  test("needs an account", async (): Promise<void> => {
    const anonymous = new Session({ eventId: "event_1", conversationKey: KEY });

    await expect(anonymous.claim()).rejects.toThrow(
      "Account ID is required for runtime claims",
    );
  });
});

describe("Session.assertCurrentOwner", (): void => {
  test("a session with no owner generation has no owner to check", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate");
    const session = new Session({
      eventId: "event_1",
      conversationKey: KEY,
      accountId: "acct_1",
    });

    await expect(session.assertCurrentOwner()).resolves.toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("Session.environmentText", (): void => {
  test("a scheduled run names no channel", (): void => {
    const session = new Session({
      eventId: "event_1",
      conversationKey: KEY,
      accountId: "acct_1",
      trigger: "cron",
    });

    expect(session.environmentText()).toContain(
      "none, this is a scheduled run",
    );
  });
});

describe("Session.appendIngressEvents", (): void => {
  test("saves a user event and hands back the ephemeral system messages", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue(undefined);
    const session = new Session({
      eventId: "event_1",
      conversationKey: KEY,
      accountId: "acct_1",
    });

    const ephemeral = await session.appendIngressEvents([
      { role: "user", content: "keep going" },
      { role: "system", content: "side note", persist: false },
    ]);

    expect(ephemeral).toEqual([{ role: "system", content: "side note" }]);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("createStoredEventFromModelMessage", (): void => {
  test("stores nothing for a role it does not know", (): void => {
    const unknown = {
      role: "developer",
      content: "x",
    } as unknown as ModelMessage;

    expect(createStoredEventFromModelMessage(unknown, "source_1")).toBeNull();
  });
});
