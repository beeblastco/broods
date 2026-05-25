/**
 * Handoff tool tests.
 * Cover current Pancake conversation handoff without hitting Pancake.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("handoffs tool", () => {
  it("adds the configured handoff tag and marks the current Pancake conversation unread", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return fetchCalls.length === 1
        ? jsonResponse({ success: true, message: "tag added", data: [6] })
        : jsonResponse({ success: true, message: "marked unread" });
    }) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");

    const tools = handoffsTool(createToolContext());

    const result = await executeHandoffs(tools.handoffs, { reason: "Customer asked for staff." });

    expect(result).toEqual({
      success: true,
      message: "marked unread",
      actions: {
        tag: { success: true, message: "tag added", data: [6] },
        unread: { success: true, message: "marked unread" },
      },
    });
    expect(fetchCalls).toHaveLength(2);
    const tagUrl = new URL(fetchCalls[0]!.url);
    expect(tagUrl.pathname).toBe("/api/public_api/v1/pages/249596441579238/conversations/conversation-1/tags");
    expect(tagUrl.searchParams.get("page_access_token")).toBe("page-token");
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(fetchCalls[0]!.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      action: "add",
      tag_id: "6",
    });

    const unreadUrl = new URL(fetchCalls[1]!.url);
    expect(unreadUrl.pathname).toBe("/api/public_api/v1/pages/249596441579238/conversations/conversation-1/unread");
    expect(unreadUrl.searchParams.get("page_access_token")).toBe("page-token");
    expect(fetchCalls[1]!.init?.method).toBe("POST");
    expect(fetchCalls[1]!.init?.body).toBeUndefined();
  });

  it("falls back to the default message when Pancake returns no message", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ success: true, data: [6] })) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");

    const tools = handoffsTool(createToolContext());

    await expect(executeHandoffs(tools.handoffs, {})).resolves.toEqual({
      success: true,
      message: "Conversation handed off to human staff.",
      actions: {
        tag: { success: true, data: [6] },
        unread: { success: true, data: [6] },
      },
    });
  });

  it("fails when marking the conversation unread fails", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      return callCount === 1
        ? jsonResponse({ success: true })
        : jsonResponse({ success: false, message: "cannot mark unread" }, 400);
    }) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext());

    await expect(executeHandoffs(tools.handoffs, {}))
      .rejects.toThrow("Pancake unread failed (400): cannot mark unread");
  });

  it("fails when Pancake does not return the handoff tag after updating tags", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ success: true, data: [] })) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext());

    await expect(executeHandoffs(tools.handoffs, {}))
      .rejects.toThrow("Pancake handoff failed: response did not include tag 6");
  });

  it("rejects non-Pancake conversations", async () => {
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext("acct:acct_test:agent:agent_test:direct:conversation"));

    await expect(executeHandoffs(tools.handoffs, {}))
      .rejects.toThrow("handoffs requires a Pancake conversation");
  });
});

function createToolContext(
  conversationKey = "acct:acct_test:agent:agent_test:pancake:249596441579238:conversation-1",
) {
  return {
    conversationKey,
    filesystemNamespace: "filesystem",
    channels: {
      pancake: {
        pageId: "249596441579238",
        pageAccessToken: "page-token",
        options: {
          handoff: { tagId: "6" },
        },
      },
    },
    config: {},
    modelProviderName: "google",
    modelProvider: {},
  } as never;
}

function executeHandoffs(toolEntry: unknown, input: unknown): Promise<unknown> {
  return (toolEntry as { execute(input: unknown): Promise<unknown> }).execute(input);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
