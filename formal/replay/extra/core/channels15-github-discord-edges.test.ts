import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createDiscordChannel } from "../../../../apps/core/src/shared/discord-channel.ts";
import { discordForwarderToken } from "../../../../apps/core/src/shared/discord-wire.ts";
import type {
  ChannelAdapter,
  ChannelParseResult,
} from "../../../../apps/core/src/shared/channels.ts";
import { createGitHubChannel } from "../../../../apps/core/src/shared/github-channel.ts";

interface Req {
  method: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body: string;
}

const ORIGINAL_FETCH = globalThis.fetch;
const REPOSITORY = {
  full_name: "owner/repo",
  name: "repo",
  owner: { login: "owner" },
};
const IGNORE: ChannelParseResult = { kind: "ignore" };

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function privateKey(): string {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

  return pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function github(
  options?: { triggerOnIssueOpen?: boolean; triggerOnPROpen?: boolean },
  botUserName?: string,
): ChannelAdapter {
  return createGitHubChannel(
    "webhook-secret",
    "app-id",
    privateKey(),
    null,
    null,
    undefined,
    botUserName,
    undefined,
    options,
  );
}

async function githubEvent(
  adapter: ChannelAdapter,
  event: string,
  payload: Record<string, unknown>,
): Promise<ChannelParseResult> {
  const request: Req = {
    method: "POST",
    rawPath: "/v1/runs",
    rawQueryString: "",
    headers: { "x-github-event": event, "x-github-delivery": "delivery-9" },
    body: JSON.stringify({
      repository: REPOSITORY,
      installation: { id: 99 },
      sender: { login: "bob", type: "User" },
      ...payload,
    }),
  };

  return await adapter.parse(request);
}

function stubFetch(responses: Response[]): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    urls.push(String(input instanceof Request ? input.url : input));
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");

    return next;
  }) as unknown as typeof fetch;

  return urls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parsePullRequestEvent", (): void => {
  test("ignores an event with no pull request number", async (): Promise<void> => {
    const parsed = await githubEvent(github(), "pull_request", {
      action: "opened",
      pull_request: {},
    });

    expect(parsed).toEqual(IGNORE);
  });

  test("turns an opened pull request into a message", async (): Promise<void> => {
    const parsed = await githubEvent(github(), "pull_request", {
      action: "opened",
      pull_request: { number: 12, title: "Fix", body: "Details" },
    });
    if (parsed.kind !== "message") throw new Error(`got ${parsed.kind}`);

    expect(parsed.message.conversationKey).toBe("gh:owner/repo:pr:12");
    expect(parsed.message.source).toMatchObject({
      pullNumber: 12,
      target: "pull_request",
      threadId: "github:owner/repo:12",
    });
  });

  test("ignores an opened pull request when open triggers are off", async (): Promise<void> => {
    const parsed = await githubEvent(
      github({ triggerOnPROpen: false }),
      "pull_request",
      { action: "opened", pull_request: { number: 12, title: "Fix" } },
    );

    expect(parsed).toEqual(IGNORE);
  });
});

describe("parseIssuesEvent", (): void => {
  test("ignores an event with no issue number", async (): Promise<void> => {
    const parsed = await githubEvent(github(), "issues", {
      action: "opened",
      issue: {},
    });

    expect(parsed).toEqual(IGNORE);
  });

  test("ignores an opened issue when open triggers are off", async (): Promise<void> => {
    const parsed = await githubEvent(
      github({ triggerOnIssueOpen: false }),
      "issues",
      { action: "opened", issue: { number: 3, title: "Bug" } },
    );

    expect(parsed).toEqual(IGNORE);
  });
});

describe("parseIssueCommentEvent", (): void => {
  test("ignores an action that is not a new or edited comment", async (): Promise<void> => {
    const parsed = await githubEvent(github(), "issue_comment", {
      action: "deleted",
      issue: { number: 3 },
      comment: { id: 5, body: "hi", user: { login: "bob", type: "User" } },
    });

    expect(parsed).toEqual(IGNORE);
  });

  test("ignores a comment with no body", async (): Promise<void> => {
    const parsed = await githubEvent(github(), "issue_comment", {
      action: "created",
      issue: { number: 3 },
      comment: { id: 5, body: "   ", user: { login: "bob", type: "User" } },
    });

    expect(parsed).toEqual(IGNORE);
  });
});

describe("parseReviewCommentEvent", (): void => {
  const comment = {
    id: 7,
    body: "@my-bot look",
    user: { login: "bob", type: "User" },
  };

  test("ignores a comment from a bot", async (): Promise<void> => {
    const parsed = await githubEvent(
      github(undefined, "my-bot"),
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: { number: 4 },
        comment: { ...comment, user: { login: "ci", type: "Bot" } },
      },
    );

    expect(parsed).toEqual(IGNORE);
  });

  test("ignores a comment with no id", async (): Promise<void> => {
    const parsed = await githubEvent(
      github(undefined, "my-bot"),
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: { number: 4 },
        comment: { body: "@my-bot look", user: comment.user },
      },
    );

    expect(parsed).toEqual(IGNORE);
  });

  test("ignores a comment that does not mention the bot", async (): Promise<void> => {
    const parsed = await githubEvent(
      github(undefined, "my-bot"),
      "pull_request_review_comment",
      {
        action: "created",
        pull_request: { number: 4 },
        comment: { ...comment, body: "nice work" },
      },
    );

    expect(parsed).toEqual(IGNORE);
  });
});

describe("createGitHubRestClient", (): void => {
  const mention = {
    action: "created",
    issue: { number: 12 },
    comment: {
      id: 55,
      body: "@my-bot hi",
      user: { login: "bob", type: "User" },
    },
  };

  async function parseMention(): Promise<ChannelParseResult> {
    return await githubEvent(
      github(undefined, "my-bot"),
      "issue_comment",
      mention,
    );
  }

  test("continues with the comment alone when the token request fails", async (): Promise<void> => {
    const urls = stubFetch([json(500, {})]);
    const parsed = await parseMention();
    if (parsed.kind !== "message") throw new Error(`got ${parsed.kind}`);

    expect(urls).toHaveLength(1);
    expect(parsed.message.content).toEqual([
      { type: "text", text: "@my-bot hi" },
    ]);
  });

  test("continues when the token response has no token", async (): Promise<void> => {
    const urls = stubFetch([json(201, {})]);
    const parsed = await parseMention();

    expect(parsed.kind).toBe("message");
    expect(urls).toHaveLength(1);
  });

  test("continues when a thread read fails", async (): Promise<void> => {
    const urls = stubFetch([
      json(201, { token: "installation-token" }),
      json(404, {}),
    ]);
    const parsed = await parseMention();

    expect(parsed.kind).toBe("message");
    expect(urls[1]).toBe("https://api.github.com/repos/owner/repo/issues/12");
  });
});

describe("parseForwardedGatewayEvent", (): void => {
  function gateway(
    channels: Set<string> | null,
    users: Set<string> | null,
  ): ChannelAdapter {
    return createDiscordChannel("bot-token", "0".repeat(64), channels, users);
  }

  async function forwarded(
    adapter: ChannelAdapter,
    payload: Record<string, unknown>,
  ): Promise<ChannelParseResult> {
    return await adapter.parse({
      method: "POST",
      rawPath: "/v1/runs",
      rawQueryString: "",
      headers: {
        "x-discord-gateway-token": discordForwarderToken("bot-token"),
      },
      body: JSON.stringify(payload),
    });
  }

  function message(data: Record<string, unknown>): Record<string, unknown> {
    return {
      type: "GATEWAY_MESSAGE_CREATE",
      data: {
        id: "message-1",
        channel_id: "channel-1",
        content: "hello",
        guild_id: "guild-1",
        mentions: [],
        mention_roles: [],
        author: { id: "user-1", username: "ada", bot: false },
        ...data,
      },
    };
  }

  function reason(parsed: ChannelParseResult): string | undefined {
    return parsed.kind === "ignore" ? parsed.reason : undefined;
  }

  test("acks a gateway event that is not a message", async (): Promise<void> => {
    const parsed = await forwarded(gateway(null, null), {
      type: "GATEWAY_GUILD_CREATE",
      data: {},
    });

    expect(parsed.kind).toBe("response");
  });

  test("acks a message with no author", async (): Promise<void> => {
    const parsed = await forwarded(
      gateway(null, null),
      message({ author: null }),
    );

    expect(parsed.kind).toBe("response");
  });

  test("ignores a bot author", async (): Promise<void> => {
    const parsed = await forwarded(
      gateway(null, null),
      message({ author: { id: "bot-1", username: "b", bot: true } }),
    );

    expect(reason(parsed)).toBe("bot_message");
  });

  test("ignores a direct message", async (): Promise<void> => {
    const parsed = await forwarded(
      gateway(null, null),
      message({ guild_id: null }),
    );

    expect(reason(parsed)).toBe("dm_disabled");
  });

  test("ignores a sender outside the allow list", async (): Promise<void> => {
    const parsed = await forwarded(
      gateway(null, new Set(["user-9"])),
      message({}),
    );

    expect(reason(parsed)).toBe("user_not_allowed");
  });

  test("ignores a channel outside the allow list", async (): Promise<void> => {
    const parsed = await forwarded(
      gateway(new Set(["channel-9"]), null),
      message({}),
    );

    expect(reason(parsed)).toBe("channel_not_allowed");
  });
});

describe("discordAttachmentType", (): void => {
  test("maps video, audio and other files", async (): Promise<void> => {
    const adapter = createDiscordChannel(
      "bot-token",
      "0".repeat(64),
      null,
      null,
    );
    const parsed = await adapter.parse({
      method: "POST",
      rawPath: "/v1/runs",
      rawQueryString: "",
      headers: {
        "x-discord-gateway-token": discordForwarderToken("bot-token"),
      },
      body: JSON.stringify({
        type: "GATEWAY_MESSAGE_CREATE",
        data: {
          id: "message-2",
          channel_id: "channel-1",
          content: "files",
          guild_id: "guild-1",
          mentions: [],
          mention_roles: [],
          author: { id: "user-1", username: "ada", bot: false },
          attachments: [
            { url: "https://cdn.example/a", content_type: "video/mp4" },
            { url: "https://cdn.example/b", content_type: "audio/mpeg" },
            { url: "https://cdn.example/c", content_type: "application/pdf" },
          ],
        },
      }),
    });
    if (parsed.kind !== "message") throw new Error(`got ${parsed.kind}`);

    expect(parsed.message.attachments?.map((a): string => a.type)).toEqual([
      "video",
      "audio",
      "file",
    ]);
  });
});

describe("callDiscordApi", (): void => {
  test("surfaces a failed sticker post", async (): Promise<void> => {
    stubFetch([new Response("Unknown Sticker", { status: 400 })]);
    const adapter = createDiscordChannel(
      "bot-token",
      "0".repeat(64),
      null,
      null,
    );
    const actions = adapter.actions({
      eventId: "event-1",
      conversationKey: "conversation-1",
      channelName: "discord",
      content: [],
      source: {
        applicationId: "app-1",
        guildId: "guild-1",
        channelId: "channel-1",
      },
    });

    await expect(actions.sendSticker?.("123")).rejects.toThrow(
      "Discord channels/channel-1/messages failed (400): Unknown Sticker",
    );
  });
});
