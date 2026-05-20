/**
 * Supabase conversation-state lifecycle tests.
 * Cover opt-in channel component behavior for customer-specific state.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createChannelLifecycleComponents,
  type ChannelLifecycleComponent,
  type ChannelLifecycleContext,
} from "../functions/harness-processing/channel-lifecycle/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("Supabase conversation-state lifecycle component", () => {
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

  it("upserts conversation state and inserts the inbound customer message", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (fetchCalls.length === 1) {
        return jsonResponse([stateRow({ reply_mode: "auto" })]);
      }
      return new Response(null, { status: 201 });
    }) as never;
    const component = createSupabaseComponent();

    const result = await component.prepareMessage!(createLifecycleContext());

    expect(result).toEqual({ shouldContinue: true });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toContain("/rest/v1/conversation_states?");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(fetchCalls[0]!.init?.headers).toMatchObject({
      apikey: "service-key",
      Authorization: "Bearer service-key",
      Prefer: "resolution=merge-duplicates,return=representation",
    });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toMatchObject({
      conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
      account_id: "acct_test",
      agent_id: "agent_test",
      channel: "pancake",
      provider_page_id: "page-1",
      provider_conversation_id: "conversation-1",
      customer_external_id: "page-customer-1",
      customer_name: "Ada",
    });
    expect(fetchCalls[1]!.url).toBe("https://supabase.example/rest/v1/conversation_messages");
    expect(JSON.parse(String(fetchCalls[1]!.init?.body))).toMatchObject({
      provider_message_id: "message-1",
      sender_type: "customer",
      sender_id: "page-customer-1",
      sender_name: "Ada",
      body: "hello pancake",
    });
  });

  it("blocks duplicate provider messages", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse([stateRow({ reply_mode: "auto" })]);
      }
      return new Response(JSON.stringify({ code: "23505" }), { status: 409 });
    }) as never;
    const component = createSupabaseComponent();

    const result = await component.prepareMessage!(createLifecycleContext());

    expect(result).toEqual({ shouldContinue: false, reason: "duplicate_message" });
  });

  it("blocks auto-reply when the state is in human mode", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse([stateRow({ reply_mode: "human" })]);
      }
      return new Response(null, { status: 201 });
    }) as never;
    const component = createSupabaseComponent();

    const result = await component.prepareMessage!(createLifecycleContext());

    expect(result).toEqual({ shouldContinue: false, reason: "reply_mode_human" });
  });

  it("loads a compact system prompt for auto-mode conversation state", async () => {
    globalThis.fetch = mock(async () => jsonResponse([
      stateRow({
        reply_mode: "auto",
        status: "open",
        current_product_name: "AquaSilk Serum",
        intent: "price_check",
      }),
    ])) as never;
    const component = createSupabaseComponent();

    const result = await component.loadContext!(createLifecycleContext());

    expect(result.canReply).toBe(true);
    expect(result.system?.[0]?.role).toBe("system");
    expect(result.system?.[0]?.content).toContain("current_product_name: AquaSilk Serum");
    expect(result.system?.[0]?.content).toContain("intent: price_check");
  });

  it("records agent replies after channel send succeeds", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(null, { status: fetchCalls.length === 1 ? 201 : 204 });
    }) as never;
    const component = createSupabaseComponent();

    await component.recordReply!(createLifecycleContext(), "Agent reply");

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe("https://supabase.example/rest/v1/conversation_messages");
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toMatchObject({
      provider_message_id: "agent:acct:acct_test:agent:agent_test:pancake:page-1:message-1:abc",
      sender_type: "agent",
      sender_id: "agent_test",
      body: "Agent reply",
    });
    expect(fetchCalls[1]!.url).toContain("/rest/v1/conversation_states?");
    expect(fetchCalls[1]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchCalls[1]!.init?.body))).toHaveProperty("last_agent_reply_at");
  });
});

function createSupabaseComponent(): ChannelLifecycleComponent {
  const [component] = createChannelLifecycleComponents({
    channels: {
      pancake: {
        pageId: "page-1",
        pageAccessToken: "page-token",
        options: {
          components: {
            conversationState: {
              provider: "supabase",
              url: "https://supabase.example",
              serviceRoleKey: "service-key",
            },
          },
        },
      },
    },
  }, "pancake");

  if (!component) {
    throw new Error("Expected Supabase conversation-state component");
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
      messageType: "INBOX",
      fromId: "customer-1",
      fromName: "Ada",
      pageCustomerId: "page-customer-1",
      insertedAt: "2026-05-20T01:02:03.000000",
      rawPayload: { event_type: "messaging" },
    },
  };
}

function stateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    account_id: "acct_test",
    agent_id: "agent_test",
    channel: "pancake",
    provider_page_id: "page-1",
    provider_conversation_id: "conversation-1",
    reply_mode: "auto",
    status: "open",
    metadata: {},
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
