/**
 * Supabase reply-mode lifecycle component tests.
 * Cover opt-in Pancake behavior for a minimal conversation state gate.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createChannelLifecycleComponents } from "../functions/_components/index.ts";
import type {
  ChannelLifecycleComponent,
  ChannelLifecycleContext,
} from "../functions/_shared/channels.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("Supabase reply-mode lifecycle component", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("does not install a component unless channel options opt in", () => {
    const components = createChannelLifecycleComponents({
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
        },
      },
    }, "pancake");

    expect(components).toEqual([]);
  });

  it("upserts a conversation state row and continues in auto mode", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse([stateRow({ reply_mode: "auto" })]);
    }) as never;
    const component = createSupabaseComponent();

    const result = await component.before!(createLifecycleContext());

    expect(result).toEqual({});
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

  it("blocks auto-reply when the state is in human mode", async () => {
    globalThis.fetch = mock(async () => jsonResponse([stateRow({ reply_mode: "human" })])) as never;
    const component = createSupabaseComponent();

    const result = await component.before!(createLifecycleContext());

    expect(result).toEqual({ stop: true, reason: "reply_mode_human" });
  });

  it("blocks auto-reply when the state is paused", async () => {
    globalThis.fetch = mock(async () => jsonResponse([stateRow({ reply_mode: "paused" })])) as never;
    const component = createSupabaseComponent();

    const result = await component.before!(createLifecycleContext());

    expect(result).toEqual({ stop: true, reason: "reply_mode_paused" });
  });
});

function createSupabaseComponent(): ChannelLifecycleComponent {
  const [component] = createChannelLifecycleComponents({
    channels: {
      pancake: {
        pageId: "page-1",
        pageAccessToken: "page-token",
        options: {
          components: [
            {
              type: "pancake-supabase-reply-mode",
              url: "https://supabase.example",
              serviceRoleKey: "service-key",
            },
          ],
        },
      },
    },
  }, "pancake");

  if (!component) {
    throw new Error("Expected Supabase reply-mode component");
  }

  return component;
}

function createLifecycleContext(): ChannelLifecycleContext {
  return {
    accountId: "acct_test",
    agentId: "agent_test",
    eventId: "acct:acct_test:agent:agent_test:pancake:page-1:message-1:abc",
    conversationKey: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    channelName: "pancake",
    content: [{ type: "text", text: "hello pancake" }],
    source: {
      pageId: "page-1",
      conversationId: "conversation-1",
      messageId: "message-1",
    },
  };
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
