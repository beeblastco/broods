import { describe, expect, it } from "bun:test";
import { createDiscordChannel } from "../functions/_shared/discord-channel.ts";

describe("discord channel adapter", () => {
  it("rejects DM interactions", () => {
    const adapter = createDiscordChannel("bot-token", "public-key", new Set(["guild-1"]));

    const parsed = adapter.parse(createRequest({
      id: "interaction-1",
      type: 2,
      token: "token-1",
      application_id: "app-1",
      channel_id: "channel-1",
      data: { name: "ask" },
      user: { id: "user-1" },
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected Discord DM to be rejected");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toContain("Discord DMs are disabled.");
  });

  it("rejects guild interactions outside the allow list", () => {
    const adapter = createDiscordChannel("bot-token", "public-key", new Set(["guild-1"]));

    const parsed = adapter.parse(createRequest({
      id: "interaction-2",
      type: 2,
      token: "token-2",
      application_id: "app-1",
      guild_id: "guild-2",
      channel_id: "channel-1",
      data: { name: "ask" },
      member: { user: { id: "user-1" } },
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected out-of-scope guild to be rejected");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toContain("This server is not allowed.");
  });

  it("accepts guild interactions inside the allow list", () => {
    const adapter = createDiscordChannel("bot-token", "public-key", new Set(["guild-1"]));

    const parsed = adapter.parse(createRequest({
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
});

function createRequest(payload: Record<string, unknown>) {
  return {
    method: "POST",
    rawPath: "/",
    headers: {
      "x-signature-ed25519": "signature",
      "x-signature-timestamp": "1234567890",
    },
    body: JSON.stringify(payload),
  };
}
