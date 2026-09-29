/** Linear adapter: the signed and timed webhook, parsing an issue comment mention, and the reply comment. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createLinearChannel } from "../src/shared/linear-channel.ts";

const API_KEY = `lin_api_${crypto.randomUUID()}`;
const WEBHOOK_SECRET = crypto.randomUUID();
const ISSUE_ID = "5a0b3c4d-0000-4000-8000-000000000001";
const COMMENT_ID = "7e1f2a3b-0000-4000-8000-000000000002";
const ORIGINAL_FETCH = globalThis.fetch;
const GRAPHQL_REQUEST = z.object({
  query: z.string(),
  variables: z.unknown().optional(),
});

interface GraphqlCall {
  query: string;
  variables: unknown;
  auth: string | null;
}

beforeEach((): void => {
  globalThis.fetch = linearApi([]);
});

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("linear channel adapter", () => {
  it("accepts only a fresh delivery signed with the webhook secret", async (): Promise<void> => {
    const adapter = channel();
    const body = JSON.stringify(commentWebhook("@acme-agent hi"));

    expect(adapter.canHandle(delivery(body, sign(body)))).toBe(true);
    expect(await adapter.authenticate(delivery(body, sign(body)))).toBe(true);
    expect(
      await adapter.authenticate(delivery(body, sign(body, "other-secret"))),
    ).toBe(false);
    expect(await adapter.authenticate(delivery(body, ""))).toBe(false);
  });

  it("refuses a captured delivery resent with a fresh timestamp header", async (): Promise<void> => {
    const stale = commentWebhook("@acme-agent hi");
    stale.webhookTimestamp = Date.now() - 5 * 60_000;
    const body = JSON.stringify(stale);

    expect(await channel().authenticate(delivery(body, sign(body)))).toBe(
      false,
    );
  });

  it("turns a comment that mentions the agent into a turn on its thread", async (): Promise<void> => {
    const body = JSON.stringify(
      commentWebhook("@acme-agent can you triage this?"),
    );
    const parsed = await channel().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");
    const threadId = `linear:${ISSUE_ID}:c:${COMMENT_ID}`;

    expect(parsed.message).toEqual({
      eventId: `linear:${COMMENT_ID}`,
      conversationKey: threadId,
      channelName: "linear",
      content: "@acme-agent can you triage this?",
      events: [
        {
          role: "system",
          content:
            "<linear_issue_context>\nIssue: ENG-42 Checkout fails on Safari\nURL: https://linear.app/acme/issue/ENG-42/checkout-fails-on-safari\n</linear_issue_context>",
          persist: false,
        },
        {
          role: "user",
          content: [{ type: "text", text: "@acme-agent can you triage this?" }],
        },
      ],
      identity: {
        workspaceRef: "org-1",
        channelId: "ENG",
        threadId: "ENG-42",
        userId: "user-ada",
        userName: "Ada Lovelace",
      },
      source: { commentId: COMMENT_ID, issueId: ISSUE_ID, threadId: threadId },
    });
  });

  it("ignores comments without a mention and other teams", async (): Promise<void> => {
    const restricted = createLinearChannel({
      ...options(),
      allowedChannelIds: new Set(["OPS"]),
    });
    const note = JSON.stringify(commentWebhook("just a note"));

    expect((await channel().parse(delivery(note, sign(note)))).kind).toBe(
      "ignore",
    );
    const body = JSON.stringify(commentWebhook("@acme-agent hi"));

    expect((await restricted.parse(delivery(body, sign(body)))).kind).toBe(
      "ignore",
    );
  });

  it("ignores its own comment by viewer id even when the profile slug differs from userName", async (): Promise<void> => {
    const own = commentWebhook("@acme-agent done, see @acme-agent notes");
    own.data.user.id = "user-agent";
    own.data.userId = "user-agent";
    own.data.user.url = "https://linear.app/acme/profiles/acme-bot";
    const body = JSON.stringify(own);

    expect((await channel().parse(delivery(body, sign(body)))).kind).toBe(
      "ignore",
    );
  });

  it("replies as a comment under the root comment", async (): Promise<void> => {
    const calls: GraphqlCall[] = [];
    globalThis.fetch = linearApi(calls);
    const body = JSON.stringify(commentWebhook("@acme-agent hi"));
    const parsed = await channel().parse(delivery(body, sign(body)));
    if (parsed.kind !== "message") throw new Error("expected a message");

    await channel().actions(parsed.message).sendText("On it.");

    const create = calls.find((call) => call.query.includes("commentCreate"));
    expect(create?.variables).toEqual({
      input: { body: "On it.", issueId: ISSUE_ID, parentId: COMMENT_ID },
    });
    expect(calls.every((call) => call.auth === API_KEY)).toBe(true);
  });
});

function channel(): ReturnType<typeof createLinearChannel> {
  return createLinearChannel(options());
}

// A `Comment` `create` event as Linear delivers it.
function commentWebhook(text: string): {
  action: string;
  type: string;
  organizationId: string;
  webhookId: string;
  webhookTimestamp: number;
  createdAt: string;
  url: string;
  data: {
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
    issueId: string;
    reactionData: object;
    userId: string;
    issue: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      teamId: string;
      team: { id: string; key: string; name: string };
    };
    user: {
      id: string;
      name: string;
      email: string;
      url: string;
    };
  };
} {
  return {
    action: "create",
    type: "Comment",
    organizationId: "org-1",
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    createdAt: "2026-09-29T10:00:00.000Z",
    url: `https://linear.app/acme/issue/ENG-42#comment-${COMMENT_ID}`,
    data: {
      id: COMMENT_ID,
      body: text,
      createdAt: "2026-09-29T10:00:00.000Z",
      updatedAt: "2026-09-29T10:00:00.000Z",
      issueId: ISSUE_ID,
      reactionData: {},
      userId: "user-ada",
      issue: {
        id: ISSUE_ID,
        identifier: "ENG-42",
        title: "Checkout fails on Safari",
        url: "https://linear.app/acme/issue/ENG-42/checkout-fails-on-safari",
        teamId: "team-eng",
        team: { id: "team-eng", key: "ENG", name: "Engineering" },
      },
      user: {
        id: "user-ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        url: "https://linear.app/acme/profiles/ada",
      },
    },
  };
}

function delivery(
  body: string,
  signature: string,
  timestamp: number = Date.now(),
): ChannelRequest {
  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct_1/linear",
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      "linear-signature": signature,
      "linear-timestamp": String(timestamp),
    },
    body: body,
  };
}

// A fetch that answers as Linear's GraphQL API and records every call.
function linearApi(calls: GraphqlCall[]): typeof fetch {
  return Object.assign(
    async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = GRAPHQL_REQUEST.parse(
        typeof init?.body === "string" ? JSON.parse(init.body) : null,
      );
      calls.push({
        query: request.query,
        variables: request.variables,
        auth: new Headers(init?.headers).get("authorization"),
      });

      return Response.json({ data: graphqlAnswer(request.query) });
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  );
}

// What Linear's GraphQL API answers to each query the adapter sends.
function graphqlAnswer(query: string): object {
  const comment = {
    id: "reply-1",
    body: "On it.",
    createdAt: "2026-09-29T10:00:05.000Z",
    updatedAt: "2026-09-29T10:00:05.000Z",
    url: "https://linear.app/acme/issue/ENG-42#comment-reply-1",
    reactionData: {},
    reactions: [],
  };
  if (query.includes("viewer")) {
    return {
      viewer: {
        id: "user-agent",
        displayName: "acme-agent",
        organization: { id: "org-1" },
      },
    };
  }
  if (query.includes("commentCreate")) {
    return {
      commentCreate: {
        success: true,
        lastSyncId: 1,
        comment: { id: "reply-1" },
      },
    };
  }

  return { comment: comment };
}

function options(): Parameters<typeof createLinearChannel>[0] {
  return {
    allowedChannelIds: null,
    allowedUserIds: null,
    apiKey: API_KEY,
    userName: "acme-agent",
    webhookSecret: WEBHOOK_SECRET,
  };
}

function sign(body: string, secret: string = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
