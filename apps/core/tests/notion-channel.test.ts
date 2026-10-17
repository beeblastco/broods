/** Notion adapter: the verification handshake and event signature, parsing a comment event, and the reply comment. */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createNotionChannel } from "../src/shared/notion-channel.ts";

const TOKEN = `ntn_${crypto.randomUUID()}`;
const VERIFICATION_TOKEN = `secret_${crypto.randomUUID().replaceAll("-", "")}`;
const PAGE_ID = "1f2e3d4c-0000-4000-8000-000000000001";
const DISCUSSION_ID = "2a3b4c5d-0000-4000-8000-000000000002";
const COMMENT_ID = "3b4c5d6e-0000-4000-8000-000000000003";
const ORIGINAL_FETCH = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("notion channel adapter", () => {
  it("takes the unsigned handshake only while no verification token is set", async (): Promise<void> => {
    const handshake = delivery(
      JSON.stringify({ verification_token: VERIFICATION_TOKEN }),
      "",
    );
    const awaiting = channel({ verificationToken: undefined });

    expect(await awaiting.authenticate(handshake)).toBe(true);
    expect(await awaiting.parse(handshake)).toEqual({
      kind: "response",
      reason: "notion verification handshake",
      response: { statusCode: 200 },
    });
    expect(await channel().authenticate(handshake)).toBe(false);
    const body = JSON.stringify(commentEvent());
    expect(await awaiting.authenticate(delivery(body, sign(body)))).toBe(false);
  });

  it("accepts only events signed with the verification token", async (): Promise<void> => {
    const body = JSON.stringify(commentEvent());

    expect(await channel().authenticate(delivery(body, sign(body)))).toBe(true);
    expect(
      await channel().authenticate(delivery(body, sign(body, "secret_other"))),
    ).toBe(false);
    expect(await channel().authenticate(delivery(body, ""))).toBe(false);
  });

  it("reads the comment an event names and turns a mention into a turn", async (): Promise<void> => {
    const requested: string[] = [];
    mockNotion(requested, "@acme-agent summarize this page");
    const body = JSON.stringify(commentEvent());
    const threadId = `notion:${PAGE_ID}:${DISCUSSION_ID}`;

    expect(await channel().parse(delivery(body, sign(body)))).toEqual({
      kind: "message",
      ack: { statusCode: 200 },
      message: {
        eventId: "notion:evt-1",
        conversationKey: threadId,
        channelName: "notion",
        content: "@acme-agent summarize this page",
        identity: {
          workspaceRef: "ws-1",
          channelId: PAGE_ID,
          threadId: DISCUSSION_ID,
          userId: "user-ada",
          userName: "Ada Lovelace",
        },
        source: { commentId: COMMENT_ID, pageId: PAGE_ID, threadId: threadId },
      },
    });
    expect(requested).toEqual([
      `GET https://api.notion.com/v1/comments/${COMMENT_ID}`,
    ]);
  });

  it("ignores comments that do not address the agent and other event types", async (): Promise<void> => {
    mockNotion([], "just a note");
    const comment = JSON.stringify(commentEvent());
    const page = JSON.stringify({
      ...commentEvent(),
      type: "page.content_updated",
    });

    expect((await channel().parse(delivery(comment, sign(comment)))).kind).toBe(
      "ignore",
    );
    expect((await channel().parse(delivery(page, sign(page)))).kind).toBe(
      "ignore",
    );
  });

  it("ignores a comment the event says a bot wrote, its own replies included", async (): Promise<void> => {
    mockNotion([], "@acme-agent here is what I found");
    const body = JSON.stringify({
      ...commentEvent(),
      authors: [{ id: "user-ada", type: "bot" }],
    });

    expect((await channel().parse(delivery(body, sign(body)))).kind).toBe(
      "ignore",
    );
  });

  it("replies into the same discussion", async (): Promise<void> => {
    const requested: string[] = [];
    const posted = mockNotion(requested, "@acme-agent hi");
    const body = JSON.stringify(commentEvent());
    const parsed = await channel().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    await channel().actions(parsed.message).sendText("Here is the summary.");

    expect(posted).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: {
          markdown: "Here is the summary.",
          discussion_id: DISCUSSION_ID,
        },
      },
    ]);
  });
});

function channel(
  overrides: Partial<Parameters<typeof createNotionChannel>[0]> = {},
): ReturnType<typeof createNotionChannel> {
  return createNotionChannel({
    allowedChannelIds: null,
    allowedUserIds: null,
    token: TOKEN,
    userName: "acme-agent",
    verificationToken: VERIFICATION_TOKEN,
    ...overrides,
  });
}

// A `comment.created` event as Notion delivers it: ids only, no comment text.
function commentEvent(): object {
  return {
    id: "evt-1",
    timestamp: "2026-09-29T10:00:00.000Z",
    workspace_id: "ws-1",
    workspace_name: "Acme",
    subscription_id: "sub-1",
    integration_id: "int-1",
    type: "comment.created",
    authors: [{ id: "user-ada", type: "person" }],
    attempt_number: 1,
    entity: { id: COMMENT_ID, type: "comment" },
    data: { page_id: PAGE_ID, parent: { id: PAGE_ID, type: "page" } },
  };
}

function delivery(body: string, signature: string): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/notion",
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-notion-signature": signature } : {}),
    },
    body: body,
  };
}

// Answers the Comments API: the comment the event names, and each reply posted.
function mockNotion(
  requested: string[],
  text: string,
): { auth: string | null; body: unknown }[] {
  const posted: { auth: string | null; body: unknown }[] = [];
  globalThis.fetch = Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      requested.push(`${method} ${url}`);
      if (method === "POST") {
        posted.push({
          auth: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });

        return Response.json({ ...comment(text), id: "reply-1" });
      }

      return Response.json(comment(text));
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  );

  return posted;
}

function comment(text: string): object {
  return {
    object: "comment",
    id: COMMENT_ID,
    parent: { type: "page_id", page_id: PAGE_ID },
    discussion_id: DISCUSSION_ID,
    created_time: "2026-09-29T10:00:00.000Z",
    last_edited_time: "2026-09-29T10:00:00.000Z",
    created_by: { object: "user", id: "user-ada", name: "Ada Lovelace" },
    rich_text: [
      {
        type: "text",
        text: { content: text, link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: "default",
        },
        plain_text: text,
        href: null,
      },
    ],
  };
}

function sign(body: string, secret: string = VERIFICATION_TOKEN): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
