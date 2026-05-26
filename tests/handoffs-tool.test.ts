/**
 * Handoff tool tests.
 * Cover Pancake scenario tags and Zalo staff pings without external calls.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("handoffs tool", () => {
  it("adds the order tag, marks unread, and pings Zalo staff", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (fetchCalls.length === 1) {
        return jsonResponse({ success: true, message: "order tag added", data: ["order-tag"] });
      }
      if (fetchCalls.length === 2) {
        return jsonResponse({ success: true, message: "marked unread" });
      }
      return jsonResponse({ ok: true, result: { message_id: `zalo-${fetchCalls.length}` } });
    }) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");

    const tools = handoffsTool(createToolContext());

    const result = await executeHandoffs(tools.handoffs, {
      scenario: "order",
      reason: "Customer wants to order serum.",
      phoneNumber: "0901234567",
    });

    expect(result).toEqual({
      success: true,
      message: "marked unread",
      actions: {
        scenarioTag: { success: true, message: "order tag added", data: ["order-tag"] },
        unread: { success: true, message: "marked unread" },
        zalo: [
          { userId: "sale-1", ok: true },
          { userId: "sale-2", ok: true },
        ],
      },
    });
    expect(fetchCalls).toHaveLength(4);
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      action: "add",
      tag_id: "order-tag",
    });

    const zaloUrl = new URL(fetchCalls[2]!.url);
    expect(zaloUrl.href).toBe("https://bot-api.zaloplatforms.com/botzalo-token/sendMessage");
    expect(JSON.parse(String(fetchCalls[2]!.init?.body))).toEqual({
      chat_id: "sale-1",
      text: [
        "[Pancake handoff]",
        "Scenario: order",
        "Reason: Customer wants to order serum.",
        "Phone: 0901234567",
        "Page ID: 249596441579238",
        "Conversation ID: conversation-1",
      ].join("\n"),
    });
    expect(JSON.parse(String(fetchCalls[3]!.init?.body))).toMatchObject({
      chat_id: "sale-2",
    });
  });

  it("adds the pending tag, marks unread, and pings Zalo staff", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      if (fetchCalls.length === 1) {
        return jsonResponse({ success: true, message: "pending tag added", data: ["pending-tag"] });
      }
      if (fetchCalls.length === 2) {
        return jsonResponse({ success: true, message: "marked unread" });
      }
      return jsonResponse({ ok: true, result: { message_id: "zalo-1" } });
    }) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");

    const tools = handoffsTool(createToolContext({
      config: {
        pancake: {
          scenarioTagIds: {
            order: "order-tag",
            pending: "pending-tag",
          },
        },
        zalo: {
          botToken: "zalo-token",
          notifyUserIds: ["sale-1"],
        },
      },
    }));

    await expect(executeHandoffs(tools.handoffs, {
      scenario: "pending",
      reason: "Customer asked for sale staff advice.",
    })).resolves.toMatchObject({
      success: true,
      actions: {
        scenarioTag: { success: true, message: "pending tag added", data: ["pending-tag"] },
        zalo: [{ userId: "sale-1", ok: true }],
      },
    });
    expect(JSON.parse(String(fetchCalls[0]!.init?.body))).toEqual({
      action: "add",
      tag_id: "pending-tag",
    });
  });

  it("requires phoneNumber for order handoffs before external calls", async () => {
    const fetchMock = mock(async () => jsonResponse({ success: true }));
    globalThis.fetch = fetchMock as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext());

    await expect(executeHandoffs(tools.handoffs, {
      scenario: "order",
      reason: "Customer wants to order.",
    })).rejects.toThrow("phoneNumber is required for order handoffs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails clearly when required handoff config is missing", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ success: true })) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext({ config: {} }));

    await expect(executeHandoffs(tools.handoffs, {
      scenario: "pending",
      reason: "Customer needs staff.",
    })).rejects.toThrow("config.tools.handoffs.pancake is required");
  });

  it("throws when the Zalo ping fails", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({ success: true, data: ["pending-tag"] });
      }
      if (callCount === 2) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ ok: false, description: "blocked" }, 400);
    }) as never;
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext());

    await expect(executeHandoffs(tools.handoffs, {
      scenario: "pending",
      reason: "Customer needs staff.",
    })).rejects.toThrow("Zalo sendMessage failed (400): blocked");
  });

  it("rejects non-Pancake conversations", async () => {
    const { default: handoffsTool } = await import("../functions/harness-processing/tools/handoffs.tool.ts");
    const tools = handoffsTool(createToolContext({
      conversationKey: "acct:acct_test:agent:agent_test:direct:conversation",
    }));

    await expect(executeHandoffs(tools.handoffs, {
      scenario: "pending",
      reason: "Customer needs staff.",
    })).rejects.toThrow("handoffs requires a Pancake conversation");
  });
});

function createToolContext(overrides: {
  conversationKey?: string;
  config?: Record<string, unknown>;
} = {}) {
  return {
    conversationKey: overrides.conversationKey ??
      "acct:acct_test:agent:agent_test:pancake:249596441579238:conversation-1",
    filesystemNamespace: "filesystem",
    channels: {
      pancake: {
        pageId: "249596441579238",
        pageAccessToken: "page-token",
      },
    },
    config: overrides.config ?? {
      pancake: {
        scenarioTagIds: {
          order: "order-tag",
          pending: "pending-tag",
        },
      },
      zalo: {
        botToken: "zalo-token",
        notifyUserIds: ["sale-1", "sale-2"],
      },
    },
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
