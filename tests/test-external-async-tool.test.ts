/**
 * Test external async fixture dispatch.
 * Keep callback contract coverage near the fixture tool.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import testExternalAsyncTool from "../functions/harness-processing/tools/test.external-async.tool.ts";

const originalFetch = globalThis.fetch;
const originalToolUrl = process.env.MOCK_EXTERNAL_ASYNC_TOOL_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToolUrl === undefined) {
    delete process.env.MOCK_EXTERNAL_ASYNC_TOOL_URL;
  } else {
    process.env.MOCK_EXTERNAL_ASYNC_TOOL_URL = originalToolUrl;
  }
});

describe("test_external_async tool", () => {
  it("dispatches the mock worker with an absolute completion URL and auth header", async () => {
    process.env.MOCK_EXTERNAL_ASYNC_TOOL_URL = "https://mock.example/start";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const tools = testExternalAsyncTool({
      config: {
        completionBaseUrl: "https://agent.example",
        completionBearerToken: "secret",
      },
    });
    const result = await (tools.test_external_async as {
      execute(input: unknown, options: unknown): Promise<unknown>;
    }).execute({ message: "world" }, {
      toolCallId: "tool-call-1",
      messages: [],
      asyncTool: {
        completePath: "/async-tools/async_tool_1/complete",
      },
    });

    expect(result).toEqual({
      type: "text",
      value: "Dispatched. The result will be injected back to the conversation when finished",
    });
    expect(calls[0]?.url).toBe("https://mock.example/start");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      message: "world",
      completeUrl: "https://agent.example/async-tools/async_tool_1/complete",
      completionHeaders: {
        Authorization: "Bearer secret",
      },
    });
  });

  it("fails dispatch when the mock worker reports callback failure", async () => {
    process.env.MOCK_EXTERNAL_ASYNC_TOOL_URL = "https://mock.example/start";
    globalThis.fetch = mock(async () => new Response("callback rejected", { status: 502 })) as unknown as typeof fetch;

    const tools = testExternalAsyncTool({
      config: {
        completionBaseUrl: "https://agent.example",
        completionBearerToken: "secret",
      },
    });

    await expect((tools.test_external_async as {
      execute(input: unknown, options: unknown): Promise<unknown>;
    }).execute({ message: "world" }, {
      toolCallId: "tool-call-1",
      messages: [],
      asyncTool: {
        completePath: "/async-tools/async_tool_1/complete",
      },
    })).rejects.toThrow("External async mock dispatch failed: 502 callback rejected");
  });
});
