import { describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import type {
  ChannelInboundEvent,
  IntegrationHandlers,
  IntegrationRoutingOptions,
} from "../../../../apps/core/src/harness/integrations.ts";
import type { AuthContext } from "../../../../apps/core/src/shared/auth.ts";
import type { CoreRequest } from "../../../../apps/core/src/shared/http.ts";

type Workspaces = readonly { name: string; sandbox?: { id: string } }[];

const written: unknown[] = [];
let workspaces: Workspaces = [];

const actualWorkspaces =
  await import("../../../../apps/core/src/shared/workspaces.ts");
await mock.module("../../../../apps/core/src/shared/workspaces.ts", () => ({
  ...actualWorkspaces,
  resolveAgentRuntime: async (): Promise<{ workspaces: Workspaces }> => ({
    workspaces: workspaces,
  }),
}));
const actualFiles =
  await import("../../../../apps/core/src/harness/conversation-files.ts");
await mock.module(
  "../../../../apps/core/src/harness/conversation-files.ts",
  () => ({
    ...actualFiles,
    readConversationFiles: async (): Promise<
      { path: string; contentBase64: string }[]
    > => [{ path: "a.txt", contentBase64: "YQ==" }],
    writeConversationFiles: async (
      _target: unknown,
      files: unknown,
    ): Promise<void> => {
      written.push(files);
    },
  }),
);

const {
  channelActionsFromConfig,
  channelAdapterFromConfig,
  createIncomingEventRouter,
} = await import("../../../../apps/core/src/harness/integrations.ts");
const { createTelegramChannel } =
  await import("../../../../apps/core/src/shared/telegram-channel.ts");

const ACCOUNT = { accountId: "acct_1", status: "active" };
const SCOPE = {
  accountId: "acct_1",
  endpointId: "ep_1",
  projectSlug: "p",
  stageSlug: "s",
};
const USER = { userId: "user_1", expiresAt: 4_102_444_800_000 };
const HANDLERS = {
  handleDirectRequest: async (): Promise<Response> => new Response("direct"),
  handleChannelRequest: async (): Promise<void> => undefined,
} as unknown as IntegrationHandlers;

function rsaPrivateKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

function serviceAccountJson(): string {
  return JSON.stringify({
    client_email: "agent@example.iam.gserviceaccount.com",
    private_key: rsaPrivateKey(),
  });
}

function configWith(
  name: string,
  channel: Record<string, unknown>,
): AgentConfig {
  return { channels: { [name]: channel } } as unknown as AgentConfig;
}

function auth(overrides: Record<string, unknown> = {}): AuthContext {
  return {
    kind: "deployment",
    account: ACCOUNT,
    ...SCOPE,
    user: USER,
    ...overrides,
  } as unknown as AuthContext;
}

function agent(publicAccess: boolean): AgentRecord {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    config: { publicAccess: publicAccess },
  } as unknown as AgentRecord;
}

function request(method: string, query: string, body = ""): CoreRequest {
  return {
    method: method,
    path: "/v1/agents/ep_1/files",
    search: query,
    query: new URLSearchParams(query),
    headers: {},
    body: body,
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

async function send(
  input: CoreRequest,
  options: Partial<IntegrationRoutingOptions> = {},
): Promise<number> {
  const route = createIncomingEventRouter({
    authResolver: async (): Promise<AuthContext | null> => auth(),
    agentLoader: async (): Promise<AgentRecord | null> => agent(true),
    deploymentLoader: async () => SCOPE,
    directApiEnabled: true,
    ...options,
  } as IntegrationRoutingOptions);

  return (await route(input, HANDLERS)).status;
}

const AGENT_QUERY = "agentId=agent_1&conversationKey=conv-1";

describe("channel adapters from config", () => {
  test.each([
    ["telegram", { botToken: "t", webhookSecret: "w", botUsername: "bot" }],
    ["telegram", { botToken: "t" }],
    [
      "github",
      {
        webhookSecret: "w",
        appId: "1",
        privateKey: rsaPrivateKey(),
        botUserName: "b",
      },
    ],
    ["github", { webhookSecret: "w" }],
    ["linear", { apiKey: "k", webhookSecret: "w", userName: "bot" }],
    ["linear", { apiKey: "k" }],
    ["slack", { botToken: "t", signingSecret: "s" }],
    ["slack", { botToken: "t", signingSecret: "s", reactionEmoji: "wave" }],
    [
      "discord",
      {
        botToken: "t",
        publicKey: "a".repeat(64),
        botUserId: "1",
        mentionRoleIds: ["2"],
      },
    ],
    ["discord", { botToken: "t", publicKey: "a".repeat(64) }],
    ["discord", { botToken: "t" }],
    ["pancake", { pageId: "p", pageAccessToken: "a", webhookSecret: "w" }],
    ["teams", { appId: "a", appPassword: "p", appType: "MultiTenant" }],
    [
      "teams",
      {
        appId: "a",
        appPassword: "p",
        appType: "SingleTenant",
        appTenantId: "t",
      },
    ],
    ["teams", { appId: "a", appPassword: "p", appType: "SingleTenant" }],
    [
      "twilio",
      { accountSid: "AC1", authToken: "t", phoneNumber: "+15550000000" },
    ],
    ["zalo", { botToken: "t", webhookSecret: "w" }],
    [
      "instagram",
      { accessToken: "a", accountId: "1", appSecret: "s", verifyToken: "v" },
    ],
    ["instagram", { accessToken: "a" }],
    ["messenger", { appSecret: "s", pageAccessToken: "a", verifyToken: "v" }],
    [
      "whatsapp",
      {
        accessToken: "a",
        appSecret: "s",
        phoneNumberId: "1",
        verifyToken: "v",
      },
    ],
  ])("%s %j", (name: string, channel: Record<string, unknown>): void => {
    const adapter = channelAdapterFromConfig(configWith(name, channel), name);
    expect(adapter === null || adapter.name === name).toBe(true);
  });

  test("gchat needs an endpoint and a parseable key", (): void => {
    const credentials = serviceAccountJson();
    expect(
      channelAdapterFromConfig(
        configWith("gchat", {
          credentials: credentials,
          endpointUrl: "https://a.example/hook",
        }),
        "gchat",
      )?.name,
    ).toBe("gchat");
    expect(
      channelAdapterFromConfig(
        configWith("gchat", {
          credentials: credentials,
          googleChatProjectNumber: "123",
        }),
        "gchat",
      )?.name,
    ).toBe("gchat");
    expect(
      channelAdapterFromConfig(
        configWith("gchat", { credentials: credentials }),
        "gchat",
      ),
    ).toBeNull();
    expect(
      channelAdapterFromConfig(
        configWith("gchat", {
          credentials: "not json",
          endpointUrl: "https://a.example/hook",
        }),
        "gchat",
      ),
    ).toBeNull();
  });

  test("actions come from the named adapter", (): void => {
    const config = configWith("slack", { botToken: "t", signingSecret: "s" });
    expect(
      channelActionsFromConfig(config, "slack", {
        teamId: "T1",
        channelId: "C1",
      }),
    ).not.toBeNull();
    expect(channelActionsFromConfig(config, "telegram", {})).toBeNull();
  });
});

describe("conversation files route", () => {
  test.each([
    ["DELETE", {}, 405],
    ["GET", { directApiEnabled: false }, 404],
    ["GET", { authResolver: async (): Promise<null> => null }, 401],
    [
      "GET",
      {
        authResolver: async (): Promise<AuthContext> =>
          auth({ endpointId: "other" }),
      },
      401,
    ],
    ["GET", { agentLoader: async (): Promise<null> => null }, 404],
    [
      "GET",
      {
        authResolver: async (): Promise<AuthContext> =>
          auth({ stageTicket: { expiresAt: 1 } }),
      },
      403,
    ],
    [
      "GET",
      { agentLoader: async (): Promise<AgentRecord> => agent(false) },
      403,
    ],
    ["GET", { deploymentLoader: async (): Promise<null> => null }, 404],
  ])("%s refused %#", async (method, options, status): Promise<void> => {
    workspaces = [];
    expect(
      await send(
        request(method, AGENT_QUERY),
        options as Partial<IntegrationRoutingOptions>,
      ),
    ).toBe(status);
  });

  test("a missing agentId is a bad request", async (): Promise<void> => {
    expect(await send(request("GET", "conversationKey=conv-1"))).toBe(400);
  });

  test("no workspace with a sandbox is not found", async (): Promise<void> => {
    workspaces = [{ name: "main" }];
    expect(await send(request("GET", AGENT_QUERY))).toBe(404);
    expect(await send(request("GET", `${AGENT_QUERY}&workspace=other`))).toBe(
      404,
    );
  });

  test("reads and writes the chosen workspace", async (): Promise<void> => {
    workspaces = [
      { name: "a", sandbox: { id: "s1" } },
      { name: "b", sandbox: { id: "s2" } },
    ];
    expect(await send(request("GET", AGENT_QUERY))).toBe(200);
    expect(await send(request("GET", `${AGENT_QUERY}&workspace=b`))).toBe(200);
    const body = JSON.stringify({
      files: [{ path: "a.txt", contentBase64: "YQ==" }],
    });
    expect(await send(request("PUT", AGENT_QUERY, body))).toBe(200);
    expect(written).toHaveLength(1);
  });

  test.each([
    ["{}", 400],
    ["not json", 400],
    ["x".repeat(6 * 1024 * 1024 + 1), 413],
  ])("a bad write body %#", async (body, status): Promise<void> => {
    workspaces = [{ name: "a", sandbox: { id: "s1" } }];
    expect(await send(request("PUT", AGENT_QUERY, body))).toBe(status);
  });
});

describe("telegram sticker urls", () => {
  const event = {
    eventId: "",
    conversationKey: "",
    channelName: "telegram",
    content: "",
    source: { chatId: 1, messageId: "1:1", threadId: "telegram:1" },
  };

  test.each(["ftp://stickers.example/a.webp", "http://", "not a url://x"])(
    "%s is refused",
    async (sticker: string): Promise<void> => {
      const actions = createTelegramChannel("t", "w", null, null, "x").actions(
        event as unknown as ChannelInboundEvent,
      );
      await expect(actions.sendSticker?.(sticker)).rejects.toThrow("sticker");
    },
  );
});
