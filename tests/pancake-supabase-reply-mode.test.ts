/**
 * Supabase reply-mode component tests.
 * Cover the minimal Pancake customer state gate.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getPancakeSupabaseReplyModeConfig } from "../functions/_components/pancake/index.ts";
import { getPancakeSupabaseReplyMode } from "../functions/_components/pancake/supabase-reply-mode.component.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("Pancake Supabase reply-mode component", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("does not resolve config unless Pancake options opt in", () => {
    const config = getPancakeSupabaseReplyModeConfig({
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
        },
      },
    });

    expect(config).toBeNull();
  });

  it("resolves Supabase reply-mode config from Pancake component options", () => {
    const config = getPancakeSupabaseReplyModeConfig({
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
    });

    expect(config).toEqual({
      url: "https://supabase.example",
      serviceRoleKey: "service-key",
    });
  });

  it("upserts a conversation state row and allows auto mode", async () => {
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

  it("blocks forwarding when the state is in human mode", async () => {
    globalThis.fetch = mock(async () => jsonResponse([stateRow({ reply_mode: "human" })])) as never;

    const result = await getPancakeSupabaseReplyMode(
      { url: "https://supabase.example", serviceRoleKey: "service-key" },
      "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    );

    expect(result).toBe("human");
  });

  it("blocks forwarding when the state is paused", async () => {
    globalThis.fetch = mock(async () => jsonResponse([stateRow({ reply_mode: "paused" })])) as never;

    const result = await getPancakeSupabaseReplyMode(
      { url: "https://supabase.example", serviceRoleKey: "service-key" },
      "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    );

    expect(result).toBe("paused");
  });
});

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
