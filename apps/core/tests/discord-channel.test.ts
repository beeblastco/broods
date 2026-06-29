import { describe, expect, it } from "bun:test";
import { createDiscordChannel } from "../functions/_shared/discord-channel.ts";

const TEST_DISCORD_PUBLIC_KEY = "0".repeat(64);

describe("discord channel adapter", () => {
  it("rejects DM interactions", async () => {
    const adapter = createDiscordChannel("bot-token", TEST_DISCORD_PUBLIC_KEY, new Set(["guild-1"]));

    const parsed = await adapter.parse(createRequest({
      id: "interaction-1",
      type: 2,
      token: "token-1",
      application_id: "app-1",
      channel_id: "channel-1",
      data: { name: "new" },
      user: { id: "user-1" },
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected Discord DM to be rejected");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toContain("Discord DMs are disabled.");
  });

  it("rejects guild interactions outside the allow list", async () => {
    const adapter = createDiscordChannel("bot-token", TEST_DISCORD_PUBLIC_KEY, new Set(["guild-1"]));

    const parsed = await adapter.parse(createRequest({
      id: "interaction-2",
      type: 2,
      token: "token-2",
      application_id: "app-1",
      guild_id: "guild-2",
      channel_id: "channel-1",
      data: { name: "new" },
      member: { user: { id: "user-1" } },
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected out-of-scope guild to be rejected");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toContain("This server is not allowed.");
  });

  it("accepts guild interactions inside the allow list", async () => {
    const adapter = createDiscordChannel("bot-token", TEST_DISCORD_PUBLIC_KEY, new Set(["guild-1"]));

    const parsed = await adapter.parse(createRequest({
      id: "interaction-3",
      type: 2,
      token: "token-3",
      application_id: "app-1",
      guild_id: "guild-1",
      channel_id: "channel-1",
      data: { name: "new" },
      member: { user: { id: "user-1" } },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected in-scope guild interaction to be accepted");
    }

    expect(parsed.message.eventId).toBe("discord:interaction-3");
    expect(parsed.message.conversationKey).toBe("discord:guild-1:channel-1");
    expect(parsed.message.source.commandToken).toBe("/new");
  });

  it("accepts gateway-forwarded message events as ordinary agent input", async () => {
    const adapter = createDiscordChannel("bot-token", TEST_DISCORD_PUBLIC_KEY, new Set(["guild-1"]));

    const parsed = await adapter.parse(createGatewayRequest({
      type: "GATEWAY_MESSAGE_CREATE",
      timestamp: Date.now(),
      data: {
        id: "message-1",
        channel_id: "channel-1",
        content: "what is the weather?",
        guild_id: "guild-1",
        timestamp: "2026-06-29T12:00:00.000Z",
        mentions: [],
        mention_roles: [],
        attachments: [],
        author: {
          id: "user-1",
          username: "ada",
          bot: false,
        },
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected gateway message to be accepted");
    }

    expect(parsed.ack?.statusCode).toBe(200);
    expect(parsed.message.eventId).toBe("discord:message-1");
    expect(parsed.message.conversationKey).toBe("discord:guild-1:channel-1");
    expect(parsed.message.content).toEqual([{ type: "text", text: "what is the weather?" }]);
    expect(parsed.message.source).toMatchObject({
      applicationId: "broods-discord-gateway",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "user-1",
    });
    expect(parsed.message.source.commandToken).toBeUndefined();
  });

  it("authenticates gateway-forwarded events with the SDK gateway token header", async () => {
    const adapter = createDiscordChannel("bot-token", TEST_DISCORD_PUBLIC_KEY, null);

    expect(await adapter.authenticate(createGatewayRequest({ type: "GATEWAY_MESSAGE_CREATE", data: {} }))).toBe(true);
    expect(await adapter.authenticate({
      ...createGatewayRequest({ type: "GATEWAY_MESSAGE_CREATE", data: {} }),
      headers: { "x-discord-gateway-token": "wrong-token" },
    })).toBe(false);
  });
});

function createRequest(payload: Record<string, unknown>) {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers: {
      "x-signature-ed25519": "signature",
      "x-signature-timestamp": "1234567890",
    },
    body: JSON.stringify(payload),
  };
}

function createGatewayRequest(payload: Record<string, unknown>) {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers: {
      "x-discord-gateway-token": "bot-token",
    },
    body: JSON.stringify(payload),
  };
}
