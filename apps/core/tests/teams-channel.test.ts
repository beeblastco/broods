/** Teams adapter: Bot Framework token check, activity parsing, and the reply send. */

import { decodeThreadId, TeamsAdapter } from "@chat-adapter/teams";
import { InboundActivityTokenValidator } from "@microsoft/teams.apps/dist/middleware/index.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createTeamsChannel } from "../src/shared/teams-channel.ts";

const APP_ID = "00000000-0000-0000-0000-00000000a99";
const CHANNEL_CONVERSATION = "19:general@thread.tacv2;messageid=1700000000000";

const restorers: (() => void)[] = [];

afterEach((): void => {
  for (const restore of restorers.splice(0)) restore();
});

describe("teams channel adapter", () => {
  it("rejects a delivery without a Bot Framework token", async (): Promise<void> => {
    const adapter = channel();
    const body = JSON.stringify(channelActivity("hello"));

    expect(await adapter.authenticate(delivery(body, undefined))).toBe(false);
    expect(await adapter.authenticate(delivery(body, "Bearer not-a-jwt"))).toBe(
      false,
    );
  });

  it("hands the token and the activity to the Teams SDK validator", async (): Promise<void> => {
    const check = spyOn(
      InboundActivityTokenValidator.prototype,
      "check",
    ).mockResolvedValue({
      appId: APP_ID,
      from: "azure",
      fromId: "",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      isExpired: (): boolean => false,
    });
    restorers.push((): void => check.mockRestore());
    const activity = channelActivity("hello");

    expect(
      await channel().authenticate(
        delivery(JSON.stringify(activity), "Bearer signed"),
      ),
    ).toBe(true);
    expect(check).toHaveBeenCalledWith("Bearer signed", activity);
  });

  it("turns a channel mention into a turn in that thread", async (): Promise<void> => {
    const parsed = await channel().parse(
      delivery(JSON.stringify(channelActivity("<at>Agent</at> ship it")), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    expect(parsed.message).toMatchObject({
      eventId: `teams:${CHANNEL_CONVERSATION}:1700000000001`,
      conversationKey: `teams:${CHANNEL_CONVERSATION}`,
      channelName: "teams",
      content: "ship it",
      identity: {
        workspaceRef: "team-1",
        channelId: "19:general@thread.tacv2",
        userId: "aad-user-1",
        userName: "Ada",
      },
      source: {
        conversationId: CHANNEL_CONVERSATION,
        messageId: "1700000000001",
        userId: "aad-user-1",
        userName: "Ada",
      },
    });
  });

  it("ignores activities that are not messages", async (): Promise<void> => {
    const update = { ...channelActivity("hi"), type: "conversationUpdate" };

    expect(
      (await channel().parse(delivery(JSON.stringify(update), ""))).kind,
    ).toBe("ignore");
  });

  it("posts the reply to the conversation the message came from", async (): Promise<void> => {
    const post = spyOn(TeamsAdapter.prototype, "postMessage").mockResolvedValue(
      { id: "reply-1", threadId: "", raw: {} },
    );
    restorers.push((): void => post.mockRestore());
    const adapter = channel();
    const parsed = await adapter.parse(
      delivery(JSON.stringify(channelActivity("<at>Agent</at> hi")), ""),
    );
    if (parsed.kind !== "message") throw new Error("expected a message");

    await adapter.actions(parsed.message).sendText("done");

    const [threadId, message] = post.mock.calls[0]!;
    expect(message).toEqual({ markdown: "done" });
    expect(decodeThreadId(threadId)).toMatchObject({
      conversationId: CHANNEL_CONVERSATION,
      serviceUrl: "https://smba.trafficmanager.net/emea/",
    });
  });
});

function channel(): ReturnType<typeof createTeamsChannel> {
  return createTeamsChannel({
    allowedChannelIds: null,
    allowedUserIds: null,
    appId: APP_ID,
    appPassword: "client-secret",
    appTenantId: "tenant-1",
  });
}

// A channel message as the Bot Framework posts it, the bot mentioned first.
function channelActivity(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "1700000000001",
    timestamp: "2026-09-29T00:00:00.000Z",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    channelId: "msteams",
    from: { id: "29:user-1", name: "Ada", aadObjectId: "aad-user-1" },
    conversation: {
      id: CHANNEL_CONVERSATION,
      conversationType: "channel",
      tenantId: "tenant-1",
    },
    recipient: { id: `28:${APP_ID}`, name: "Agent" },
    text: text,
    entities: [
      {
        type: "mention",
        text: "<at>Agent</at>",
        mentioned: { id: `28:${APP_ID}`, name: "Agent" },
      },
    ],
    channelData: {
      team: { id: "team-1" },
      channel: { id: "19:general@thread.tacv2" },
      tenant: { id: "tenant-1" },
    },
  };
}

function delivery(
  body: string,
  authorization: string | undefined,
): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/teams",
    rawQueryString: "",
    headers:
      authorization === undefined ? {} : { authorization: authorization },
    body: body,
  };
}
