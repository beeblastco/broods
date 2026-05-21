/**
 * Pancake channel adapter tests.
 * Cover webhook normalization and page-scoped filtering here.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createPancakeChannel,
  getPancakeSupabaseReplyMode,
} from "../functions/_shared/pancake-channel.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("pancake channel adapter", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("normalizes messaging events into page-scoped conversations", async () => {
    const adapter = createPancakeChannel("page-1", "page-token");
    const parsed = await adapter.parse(createPancakeRequest({
      page_id: "page-1",
      event_type: "messaging",
      data: {
        conversation: {
          id: "conversation-1",
          type: "INBOX",
          from: { id: "customer-1", name: "Ada" },
        },
        message: {
          id: "message-1",
          conversation_id: "conversation-1",
          page_id: "page-1",
          message: "hello pancake",
          type: "INBOX",
          from: {
            id: "customer-1",
            name: "Ada",
            page_customer_id: "page-customer-1",
          },
        },
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake message event to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    expect(parsed.message.eventId).toBe(`pancake:page-1:message-1:${hashText("hello pancake")}`);
    expect(parsed.message.conversationKey).toBe("pancake:page-1:conversation-1");
    expect(parsed.message.channelName).toBe("pancake");
    expect(parsed.message.content).toEqual([{ type: "text", text: "hello pancake" }]);
    expect(parsed.message.source).toMatchObject({
      pageId: "page-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      messageType: "INBOX",
      fromId: "customer-1",
      fromName: "Ada",
      pageCustomerId: "page-customer-1",
    });
  });

  it("carries comment source fields for comment replies", async () => {
    const adapter = createPancakeChannel("page-1", "page-token");
    const parsed = await adapter.parse(createPancakeRequest({
      page_id: "page-1",
      event_type: "messaging",
      data: {
        conversation: { id: "comment-conversation", type: "COMMENT" },
        message: {
          id: "comment-1",
          conversation_id: "comment-conversation",
          page_id: "page-1",
          message: "price?",
          type: "COMMENT",
          from: { id: "customer-1", name: "Ada" },
        },
        post: { id: "post-1" },
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake comment event to be accepted");
    }

    expect(parsed.message.source).toMatchObject({
      messageType: "COMMENT",
      messageId: "comment-1",
      postId: "post-1",
    });
  });

  it("ignores non-message events, wrong pages, empty text, and page-originated messages", async () => {
    const adapter = createPancakeChannel("page-1", "page-token");

    expect(await adapter.parse(createPancakeRequest({ event_type: "post", page_id: "page-1" }))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createPancakeRequest(validPayload({ page_id: "page-2" })))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createPancakeRequest(validPayload({ message: { message: "   " } })))).toEqual({
      kind: "ignore",
    });
    expect(await adapter.parse(createPancakeRequest(validPayload({
      message: { from: { id: "page-1", name: "Page" } },
    })))).toEqual({ kind: "ignore" });
  });

  it("upserts a Supabase conversation state row and allows auto mode", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse([stateRow({ reply_mode: "auto" })]);
    }) as never;

    const result = await getPancakeSupabaseReplyMode(
      { url: "https://supabase.example", serviceRoleKey: "service-key" },
      "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    );

    expect(result).toBe("auto");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("/rest/v1/conversation_states?");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(fetchCalls[0]!.init?.headers).toMatchObject({
      apikey: "service-key",
      Authorization: "Bearer service-key",
      Prefer: "resolution=merge-duplicates,return=representation",
    });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    });
  });

  it("uses Supabase options to ignore human and paused reply modes", async () => {
    const adapter = createPancakeChannel("page-1", "page-token", undefined, {
      accountId: "acct_test",
      agentId: "agent_test",
      configOptions: {
        supabase: { url: "https://supabase.example", serviceRoleKey: "service-key" },
      },
    });
    globalThis.fetch = mock(async () => jsonResponse([stateRow({ reply_mode: "human" })])) as never;

    const humanParsed = await adapter.parse(createPancakeRequest(validPayload()));

    expect(humanParsed.kind).toBe("ignore");
    expect(humanParsed).toEqual({
      kind: "ignore",
      response: { statusCode: 200 },
    });

    globalThis.fetch = mock(async () => jsonResponse([stateRow({ reply_mode: "paused" })])) as never;

    const pausedParsed = await adapter.parse(createPancakeRequest(validPayload()));

    expect(pausedParsed).toEqual({
      kind: "ignore",
      response: { statusCode: 200 },
    });
  });
});

function createPancakeRequest(payload: Record<string, unknown>) {
  return {
    method: "POST",
    rawPath: "/",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function validPayload(overrides: {
  page_id?: string;
  message?: Record<string, unknown>;
} = {}) {
  return {
    page_id: overrides.page_id ?? "page-1",
    event_type: "messaging",
    data: {
      conversation: { id: "conversation-1", type: "INBOX" },
      message: {
        id: "message-1",
        conversation_id: "conversation-1",
        page_id: overrides.page_id ?? "page-1",
        message: "hello",
        type: "INBOX",
        from: { id: "customer-1", name: "Ada" },
        ...overrides.message,
      },
    },
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function stateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    reply_mode: "auto",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
