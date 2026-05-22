/**
 * Pancake reply-mode tool tests.
 * Cover the model-facing handoff tool without running the full harness.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import pancakeHandoffToHumanTool from "../functions/harness-processing/tools/pancake-handoff-to-human.tool.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("pancake_handoff_to_human tool", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("patches the current Pancake conversation from auto to human", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse([{
        conversation_key: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
        reply_mode: "human",
      }]);
    }) as never;

    const tools = pancakeHandoffToHumanTool(createToolContext(), createAgentConfig());
    const result = await (tools.pancake_handoff_to_human as unknown as {
      execute(input: unknown): Promise<unknown>;
    }).execute({});

    expect(result).toEqual({
      type: "text",
      value: expect.stringContaining("request has been raised with human staff"),
    });
    expect(fetchCalls).toHaveLength(1);
    const url = new URL(fetchCalls[0]!.url);
    expect(url.pathname).toBe("/rest/v1/conversation_states");
    expect(url.searchParams.get("conversation_key")).toBe(
      "eq.acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    );
    expect(url.searchParams.get("reply_mode")).toBe("eq.auto");
    expect(fetchCalls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      reply_mode: "human",
    });
  });

  it("requires Pancake Supabase channel options", async () => {
    const tools = pancakeHandoffToHumanTool(createToolContext(), createAgentConfig({
      channels: {
        pancake: {
          pageId: "page-1",
          pageAccessToken: "page-token",
        },
      },
    }));

    await expect((tools.pancake_handoff_to_human as unknown as {
      execute(input: unknown): Promise<unknown>;
    }).execute({})).rejects.toThrow("pancake_handoff_to_human requires config.channels.pancake.options.supabase");
  });
});

function createToolContext(overrides: Record<string, unknown> = {}) {
  return {
    conversationKey: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
    filesystemNamespace: "filesystem",
    config: {},
    modelProviderName: "google",
    modelProvider: {},
    ...overrides,
  } as never;
}

function createAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    channels: {
      pancake: {
        pageId: "page-1",
        pageAccessToken: "page-token",
        options: {
          supabase: {
            url: "https://supabase.example",
            serviceRoleKey: "service-key",
          },
        },
      },
    },
    ...overrides,
  } as never;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
