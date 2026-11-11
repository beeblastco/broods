import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import type {
  ChannelInboundEvent,
  IntegrationHandlers,
  IntegrationRoutingOptions,
} from "../../../../apps/core/src/harness/integrations.ts";
import type { AuthContext } from "../../../../apps/core/src/shared/auth.ts";
import type { CoreRequest } from "../../../../apps/core/src/shared/http.ts";

const actualWorkspaces =
  await import("../../../../apps/core/src/shared/workspaces.ts");
await mock.module("../../../../apps/core/src/shared/workspaces.ts", () => ({
  ...actualWorkspaces,
  resolveAgentRuntime: async (): Promise<{
    workspaces: { name: string; sandbox: { id: string } }[];
  }> => ({
    workspaces: [{ name: "a", sandbox: { id: "s1" } }],
  }),
}));
const actualFiles =
  await import("../../../../apps/core/src/harness/conversation-files.ts");
await mock.module(
  "../../../../apps/core/src/harness/conversation-files.ts",
  () => ({
    ...actualFiles,
    readConversationFiles: async (): Promise<unknown[]> => [],
    writeConversationFiles: async (): Promise<void> => undefined,
  }),
);

const { createIncomingEventRouter } =
  await import("../../../../apps/core/src/harness/integrations.ts");
const { createTelegramChannel } =
  await import("../../../../apps/core/src/shared/telegram-channel.ts");

const SCOPE = {
  accountId: "acct_1",
  endpointId: "ep_1",
  projectSlug: "p",
  stageSlug: "s",
};
const AUTH = {
  kind: "deployment",
  account: { accountId: "acct_1", status: "active" },
  ...SCOPE,
  user: { userId: "user_1", expiresAt: 4_102_444_800_000 },
} as unknown as AuthContext;
const QUERY = "agentId=agent_1&conversationKey=conv-1";

async function put(body: string): Promise<number> {
  const route = createIncomingEventRouter({
    authResolver: async (): Promise<AuthContext> => AUTH,
    agentLoader: async (): Promise<AgentRecord> =>
      ({
        accountId: "acct_1",
        agentId: "agent_1",
        config: { publicAccess: true },
      }) as unknown as AgentRecord,
    deploymentLoader: async () => SCOPE,
    directApiEnabled: true,
  } as IntegrationRoutingOptions);
  const request: CoreRequest = {
    method: "PUT",
    path: "/v1/agents/ep_1/files",
    search: QUERY,
    query: new URLSearchParams(QUERY),
    headers: {},
    body: body,
    cookies: [],
    clientIp: "127.0.0.1",
  };

  return (await route(request, {} as IntegrationHandlers)).status;
}

describe("conversation file writes", () => {
  test.each([
    ['{"files":[]}', 200],
    ['{"files":[{"path":"b","contentBase64":""}]}', 200],
    [
      '{"files":[{"path":"a","contentBase64":"YQ=="},{"path":"b","contentBase64":"Yg=="}]}',
      200,
    ],
    ['{"files":"x"}', 400],
    ['{"files":[{"path":1,"contentBase64":""}]}', 400],
    ['{"files":[{"path":"a"}]}', 400],
    ["[]", 400],
    ["null", 400],
    ["3", 400],
    ['"text"', 400],
  ])("%s answers %d", async (body: string, status: number): Promise<void> => {
    expect(await put(body)).toBe(status);
  });
});

describe("telegram sticker urls that pass", () => {
  test.each([
    "https://stickers.example/a.webp",
    "http://stickers.example/b.webp",
  ])("%s is sent", async (sticker: string): Promise<void> => {
    const fetched = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: {} })),
    );
    const event = {
      eventId: "",
      conversationKey: "",
      channelName: "telegram",
      content: "",
      source: { chatId: 1, messageId: "1:1", threadId: "telegram:1" },
    } as unknown as ChannelInboundEvent;
    await createTelegramChannel("t", "w", null, null, "x")
      .actions(event)
      .sendSticker?.(sticker);
    expect(fetched).toHaveBeenCalledTimes(1);
    fetched.mockRestore();
  });
});
