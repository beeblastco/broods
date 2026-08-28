import { describe, expect, it } from "bun:test";
import type { InboundMessage } from "../src/shared/channels.ts";
import { createDiscordChannel } from "../src/shared/discord-channel.ts";

const TEST_DISCORD_PUBLIC_KEY = "0".repeat(64);

describe("discord channel adapter", () => {
  it("rejects DM interactions", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const parsed = await adapter.parse(
      createRequest({
        id: "interaction-1",
        type: 2,
        token: "token-1",
        application_id: "app-1",
        channel_id: "channel-1",
        data: { name: "new" },
        user: { id: "user-1" },
      }),
    );

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected Discord DM to be rejected");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toContain("Discord DMs are disabled.");
  });

  it("rejects interactions in a channel outside the allow list", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const parsed = await adapter.parse(
      createRequest({
        id: "interaction-2",
        type: 2,
        token: "token-2",
        application_id: "app-1",
        guild_id: "guild-1",
        channel_id: "channel-9",
        data: { name: "new" },
        member: { user: { id: "user-1" } },
      }),
    );

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected out-of-scope channel to be rejected");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toContain("This channel is not allowed.");
  });

  it("accepts guild interactions inside the allow list", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const parsed = await adapter.parse(
      createRequest({
        id: "interaction-3",
        type: 2,
        token: "token-3",
        application_id: "app-1",
        guild_id: "guild-1",
        channel_id: "channel-1",
        data: { name: "new" },
        member: { user: { id: "user-1" } },
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected in-scope guild interaction to be accepted");
    }

    expect(parsed.message.eventId).toBe("discord:interaction-3");
    expect(parsed.message.conversationKey).toBe("discord:guild-1:channel-1");
    expect(parsed.message.source.commandToken).toBe("/new");
  });

  it("accepts gateway-forwarded message events as ordinary agent input", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const parsed = await adapter.parse(
      createGatewayRequest({
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
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected gateway message to be accepted");
    }

    expect(parsed.ack?.statusCode).toBe(200);
    expect(parsed.message.eventId).toBe("discord:message-1");
    expect(parsed.message.conversationKey).toBe("discord:guild-1:channel-1");
    expect(parsed.message.content).toEqual([
      { type: "text", text: "ada: what is the weather?" },
    ]);
    expect(parsed.message.source).toMatchObject({
      applicationId: "broods-discord-gateway",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "user-1",
    });
    expect(parsed.message.source.commandToken).toBeUndefined();
  });

  it("accepts a human author with no bot flag, the shape Discord actually sends", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const parsed = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-3",
          channel_id: "channel-1",
          content: "ship it",
          guild_id: "guild-1",
          mentions: [],
          mention_roles: [],
          // Discord omits `bot` entirely for human authors.
          author: { id: "user-1", username: "ada" },
        },
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected a bot-flag-less author to be treated as human");
    }

    expect(parsed.message.eventId).toBe("discord:message-3");
    expect(parsed.message.content).toEqual([
      { type: "text", text: "ada: ship it" },
    ]);
  });

  it("keys a slash command inside a thread to the same key as a gateway message", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const interaction = await adapter.parse(
      createRequest({
        id: "interaction-4",
        type: 2,
        token: "token-4",
        application_id: "app-1",
        guild_id: "guild-1",
        channel_id: "thread-1",
        channel: { id: "thread-1", type: 11, parent_id: "channel-1" },
        data: { name: "new" },
        member: { user: { id: "user-1" } },
      }),
    );
    const gateway = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-2",
          channel_id: "thread-1",
          content: "still broken",
          guild_id: "guild-1",
          thread: { id: "thread-1", parent_id: "channel-1" },
          mentions: [],
          mention_roles: [],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );

    if (interaction.kind !== "message" || gateway.kind !== "message") {
      throw new Error("Expected both thread events to be accepted");
    }

    expect(interaction.message.conversationKey).toBe(
      "discord:guild-1:channel-1:thread-1",
    );
    expect(gateway.message.conversationKey).toBe(
      interaction.message.conversationKey,
    );
    expect(interaction.message.source.channelId).toBe("channel-1");
    expect(interaction.message.source.threadId).toBe(
      "discord:guild-1:channel-1:thread-1",
    );
  });

  it("keys a slash command outside a thread to the channel", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );

    const parsed = await adapter.parse(
      createRequest({
        id: "interaction-5",
        type: 2,
        token: "token-5",
        application_id: "app-1",
        guild_id: "guild-1",
        channel_id: "channel-1",
        channel: { id: "channel-1", type: 0, parent_id: "category-1" },
        data: { name: "new" },
        member: { user: { id: "user-1" } },
      }),
    );

    if (parsed.kind !== "message") {
      throw new Error("Expected channel interaction to be accepted");
    }

    // parent_id on a normal text channel is its category, never a thread parent.
    expect(parsed.message.conversationKey).toBe("discord:guild-1:channel-1");
    expect(parsed.message.source.threadId).toBeUndefined();
  });

  it("runs the agent only when it is mentioned once botUserId is configured", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
      undefined,
      { botUserId: "bot-9" },
    );

    const mentioned = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-3",
          channel_id: "channel-1",
          content: "<@bot-9> ship the fix",
          guild_id: "guild-1",
          mentions: [{ id: "bot-9", username: "nhi" }],
          mention_roles: [],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );
    const overheard = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-4",
          channel_id: "channel-1",
          content: "deploys are frozen until the postmortem",
          guild_id: "guild-1",
          mentions: [],
          mention_roles: [],
          author: { id: "user-2", username: "minh", bot: false },
        },
      }),
    );

    expect(mentioned.kind).toBe("message");
    expect(overheard.kind).toBe("context");
    if (mentioned.kind !== "message" || overheard.kind !== "context") {
      throw new Error("Expected one run and one stored context event");
    }

    // The bot's own mention is stripped; the sender is prefixed either way.
    expect(mentioned.message.content).toEqual([
      { type: "text", text: "ada: ship the fix" },
    ]);
    expect(overheard.message.content).toEqual([
      { type: "text", text: "minh: deploys are frozen until the postmortem" },
    ]);
    expect(overheard.ack?.statusCode).toBe(200);
  });

  it("treats a configured mention role as addressing the agent", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
      undefined,
      { botUserId: "bot-9", mentionRoleIds: ["role-oncall"] },
    );

    const parsed = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-5",
          channel_id: "channel-1",
          content: "<@&role-oncall> who is on this?",
          guild_id: "guild-1",
          mentions: [],
          mention_roles: ["role-oncall"],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );

    expect(parsed.kind).toBe("message");
  });

  it("resolves other members' mentions to names and keeps commands bare", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
      undefined,
      { botUserId: "bot-9" },
    );

    const mention = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-6",
          channel_id: "channel-1",
          content: "<@bot-9> ask <@user-2> about the rollback",
          guild_id: "guild-1",
          mentions: [
            { id: "bot-9", username: "nhi" },
            { id: "user-2", username: "minh" },
          ],
          mention_roles: [],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );
    const command = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-7",
          channel_id: "channel-1",
          content: "<@bot-9> /new",
          guild_id: "guild-1",
          mentions: [{ id: "bot-9", username: "nhi" }],
          mention_roles: [],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );

    if (mention.kind !== "message" || command.kind !== "message") {
      throw new Error("Expected both mentions to be accepted");
    }

    expect(mention.message.content).toEqual([
      { type: "text", text: "ada: ask @minh about the rollback" },
    ]);
    // Attribution would push the token off the front and break /new.
    expect(command.message.content).toEqual([{ type: "text", text: "/new" }]);
  });

  it("ignores a message that is only a mention of the agent", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
      undefined,
      { botUserId: "bot-9" },
    );

    const parsed = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-8",
          channel_id: "channel-1",
          content: "<@bot-9>",
          guild_id: "guild-1",
          mentions: [{ id: "bot-9", username: "nhi" }],
          mention_roles: [],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );

    expect(parsed.kind).toBe("ignore");
  });

  it("authenticates gateway-forwarded events with the SDK gateway token header", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      null,
      null,
    );

    expect(
      await adapter.authenticate(
        createGatewayRequest({ type: "GATEWAY_MESSAGE_CREATE", data: {} }),
      ),
    ).toBe(true);
    expect(
      await adapter.authenticate({
        ...createGatewayRequest({ type: "GATEWAY_MESSAGE_CREATE", data: {} }),
        headers: { "x-discord-gateway-token": "wrong-token" },
      }),
    ).toBe(false);
  });

  it("accepts an upload with no message text and carries it as an attachment", async () => {
    // An image-only message used to be dropped as `empty_message`.
    const message = await parseGatewayMedia("message-media-1", "", [
      {
        id: "a1",
        url: "https://cdn.discordapp.com/attachments/1/2/chart.png?ex=abc",
        filename: "chart.png",
        content_type: "image/png",
        size: 4096,
        width: 800,
        height: 600,
      },
    ]);

    expect(message.attachments).toEqual([
      expect.objectContaining({
        type: "image",
        url: "https://cdn.discordapp.com/attachments/1/2/chart.png?ex=abc",
        name: "chart.png",
        mimeType: "image/png",
        width: 800,
        height: 600,
      }),
    ]);
  });

  it("reads a voice message by its shape, since Discord labels it application/ogg", async () => {
    const message = await parseGatewayMedia("message-media-2", "", [
      {
        id: "a2",
        url: "https://cdn.discordapp.com/attachments/1/3/voice-message.ogg",
        filename: "voice-message.ogg",
        content_type: "application/ogg",
        duration_secs: 4.2,
        waveform: "AAAA",
      },
    ]);

    expect(message.attachments?.[0]).toMatchObject({ type: "audio" });
    // The claimed type is dropped on purpose: keeping `application/ogg` would
    // let it override the sniff that identifies the real codec.
    expect(message.attachments?.[0]?.mimeType).toBeUndefined();
  });

  it("carries a sticker as the picture Discord serves for it", async () => {
    const message = await parseGatewayMedia(
      "message-media-3",
      "nice",
      [],
      [
        { id: "555", name: "party-blob", format_type: 1 },
        // Lottie is a JSON animation with no raster form, so there is nothing
        // worth fetching.
        { id: "666", name: "spinny", format_type: 3 },
      ],
    );

    expect(message.attachments).toEqual([
      expect.objectContaining({
        type: "image",
        url: "https://media.discordapp.net/stickers/555.png",
        name: "party-blob.png",
      }),
    ]);
  });

  it("still ignores a message with neither text nor media", async () => {
    const adapter = createDiscordChannel(
      "bot-token",
      TEST_DISCORD_PUBLIC_KEY,
      new Set(["channel-1"]),
      null,
    );
    const parsed = await adapter.parse(
      createGatewayRequest({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-media-4",
          channel_id: "channel-1",
          content: "   ",
          guild_id: "guild-1",
          mentions: [],
          mention_roles: [],
          attachments: [],
          author: { id: "user-1", username: "ada", bot: false },
        },
      }),
    );

    expect(parsed.kind).toBe("ignore");
  });
});

async function parseGatewayMedia(
  id: string,
  content: string,
  attachments: Array<Record<string, unknown>>,
  stickerItems: Array<Record<string, unknown>> = [],
): Promise<InboundMessage> {
  const adapter = createDiscordChannel(
    "bot-token",
    TEST_DISCORD_PUBLIC_KEY,
    new Set(["channel-1"]),
    null,
  );
  const parsed = await adapter.parse(
    createGatewayRequest({
      type: "GATEWAY_MESSAGE_CREATE",
      data: {
        id: id,
        channel_id: "channel-1",
        content: content,
        guild_id: "guild-1",
        mentions: [],
        mention_roles: [],
        attachments: attachments,
        ...(stickerItems.length > 0 ? { sticker_items: stickerItems } : {}),
        author: { id: "user-1", username: "ada", bot: false },
      },
    }),
  );
  if (parsed.kind !== "message") {
    throw new Error(
      `Expected the Discord media message to be accepted, got ${parsed.kind}`,
    );
  }

  return parsed.message;
}

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
