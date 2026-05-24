/**
 * Pancake tag mutation tool tests.
 * Cover current-conversation tag updates without hitting Pancake.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("pancake_toggle_tag tool", () => {
  it("adds the configured handoff tag to the current Pancake conversation", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ data: [6] });
    }) as never;
    const { default: pancakeToggleTagTool } = await import("../functions/harness-processing/tools/pancake-toggle-tag.tool.ts");

    const tools = pancakeToggleTagTool(createToolContext({
      channels: {
        pancake: {
          pageId: "249596441579238",
          pageAccessToken: "page-token",
          options: {
            handoff: { tagId: "6" },
          },
        },
      },
      tools: {
        pancake_toggle_tag: { enabled: true },
      },
    }));

    const result = await executePancakeToggleTag(tools.pancake_toggle_tag, { action: "add" });

    expect(result).toEqual({
      type: "text",
      value: "Pancake tag 6 added to conversation conversation-1.",
    });
    expect(fetchCalls).toHaveLength(1);
    const requestUrl = new URL(fetchCalls[0]!.url);
    expect(requestUrl.pathname).toBe("/api/public_api/v1/pages/249596441579238/conversations/conversation-1/tags");
    expect(requestUrl.searchParams.get("page_access_token")).toBe("page-token");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      action: "add",
      tag_id: "6",
    });
  });

  it("allows an explicit tag id and remove action", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ data: [] })) as never;
    const { default: pancakeToggleTagTool } = await import("../functions/harness-processing/tools/pancake-toggle-tag.tool.ts");

    const tools = pancakeToggleTagTool(createToolContext({
      channels: {
        pancake: {
          pageId: "249596441579238",
          pageAccessToken: "page-token",
        },
      },
      tools: {
        pancake_toggle_tag: { enabled: true },
      },
    }));

    const result = await executePancakeToggleTag(tools.pancake_toggle_tag, {
      action: "remove",
      tagId: "9",
    });

    expect(result).toEqual({
      type: "text",
      value: "Pancake tag 9 removed from conversation conversation-1.",
    });
  });

  it("rejects non-Pancake conversations", async () => {
    const { default: pancakeToggleTagTool } = await import("../functions/harness-processing/tools/pancake-toggle-tag.tool.ts");
    const tools = pancakeToggleTagTool(createToolContext({
      conversationKey: "acct:acct_test:agent:agent_test:direct:conversation",
      channels: {
        pancake: {
          pageId: "249596441579238",
          pageAccessToken: "page-token",
          options: {
            handoff: { tagId: "6" },
          },
        },
      },
      tools: {
        pancake_toggle_tag: { enabled: true },
      },
    }));

    await expect(executePancakeToggleTag(tools.pancake_toggle_tag, { action: "add" }))
      .rejects.toThrow("pancake_toggle_tag requires a Pancake conversation");
  });
});

function createToolContext(agentConfig: Record<string, unknown> & {
  conversationKey?: string;
}) {
  const { conversationKey, ...config } = agentConfig;

  return {
    conversationKey: conversationKey ?? "acct:acct_test:agent:agent_test:pancake:249596441579238:conversation-1",
    filesystemNamespace: "filesystem",
    channels: config.channels,
    config: (config.tools as { pancake_toggle_tag?: Record<string, unknown> } | undefined)?.pancake_toggle_tag ?? {},
    modelProviderName: "google",
    modelProvider: {},
  } as never;
}

function executePancakeToggleTag(toolEntry: unknown, input: unknown): Promise<unknown> {
  return (toolEntry as { execute(input: unknown): Promise<unknown> }).execute(input);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
