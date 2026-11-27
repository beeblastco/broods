import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import type {
  ChannelActions,
  ChannelRequest,
} from "../../../../apps/core/src/shared/channels.ts";
import {
  executeCommand,
  type CommandContext,
} from "../../../../apps/core/src/shared/commands.ts";
import { createTeamsChannel } from "../../../../apps/core/src/shared/teams-channel.ts";

const originalMutate = runtime.mutate.bind(runtime);
const sent: string[] = [];
let leaseAnswer: number | null = 1;

beforeEach((): void => {
  sent.length = 0;
  leaseAnswer = 1;
  runtime.mutate = mock((name: string): Promise<unknown> => {
    if (name === "acquireIngressClear") return Promise.resolve(leaseAnswer);
    if (name === "clearFencedConversation") {
      return Promise.resolve({ deleted: 0, hasMore: false });
    }

    return Promise.resolve(null);
  }) as never;
});

afterEach((): void => {
  runtime.mutate = originalMutate;
});

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  const channel: ChannelActions = {
    sendText: async (text: string): Promise<void> => {
      sent.push(text);
    },
    sendTyping: async (): Promise<void> => {},
    reactToMessage: async (): Promise<void> => {},
  };

  return {
    conversationKey: "conversation-1",
    channel: channel,
    accountId: "account-1",
    agentId: "agent-1",
    eventId: "event-1",
    ...overrides,
  };
}

describe("withIngressClearLease", (): void => {
  test("says a clear must wait while a turn is active", async (): Promise<void> => {
    leaseAnswer = null;

    await executeCommand("/new", context());

    expect(sent).toEqual([
      "Cannot clear while a turn or queued message is active. Try again after it finishes.",
    ]);
  });

  test("refuses a clear that has no event scope", async (): Promise<void> => {
    const result = await executeCommand(
      "/new",
      context({ eventId: undefined }),
    );

    expect(result?.error).toBe(
      "clear requires account, agent, and event scope",
    );
  });
});

describe("tokenValidator", (): void => {
  test("keeps rejecting a bad token as the validator cache turns over", async (): Promise<void> => {
    const body = JSON.stringify({
      type: "message",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
    });
    const request: ChannelRequest = {
      method: "POST",
      rawPath: "/v1/webhooks/acct_1/teams",
      rawQueryString: "",
      headers: { authorization: "Bearer not-a-jwt" },
      body: body,
    };
    const verdicts: boolean[] = [];

    for (let index = 0; index < 102; index += 1) {
      const adapter = createTeamsChannel({
        allowedChannelIds: null,
        allowedUserIds: null,
        appId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
        appPassword: "client-secret",
        appTenantId: "tenant-1",
      });
      verdicts.push(await adapter.authenticate(request));
    }

    expect(verdicts.every((verdict): boolean => !verdict)).toBe(true);
  });
});
