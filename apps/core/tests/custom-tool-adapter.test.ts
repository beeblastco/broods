/**
 * The AI SDK adapter for uploaded tools. It must resolve the executor's stream
 * to a value: the SDK takes execute()'s return as the tool result, so returning
 * the async generator itself serialized to `{}` and the bundle never ran.
 */

import { describe, expect, it, mock } from "bun:test";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ExecuteAccountToolOptions } from "../src/harness/custom-tools/payload.ts";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";

const streamAccountTool = mock(async function* (
  _options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown> {
  yield { step: 1 };
  yield { done: true };
});

mock.module("../src/harness/custom-tools/executor.ts", () => ({
  streamAccountTool: streamAccountTool,
}));

describe("accountTool adapter", () => {
  it("resolves the executor stream to its final value", async () => {
    const output = await execute({ message: "hi" });

    expect(output).toEqual({ done: true });
  });

  it("never hands the raw generator back to the AI SDK", async () => {
    const output = await execute({ message: "hi" });

    // A generator has no own enumerable keys, so it JSON-serializes to `{}` —
    // the exact silent failure this adapter shipped with.
    expect(JSON.stringify(output)).not.toBe("{}");
    expect(
      (output as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator],
    ).toBeUndefined();
  });

  it("surfaces a failing bundle instead of swallowing it", async () => {
    streamAccountTool.mockImplementationOnce(
      async function* (): AsyncGenerator<unknown> {
        throw new Error("bundle blew up");
      },
    );

    await expect(execute({ message: "hi" })).rejects.toThrow("bundle blew up");
  });

  it("executes parallel calls through the installed AI SDK v7 tool loop", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const concurrentStream = async function* (
      options: ExecuteAccountToolOptions,
    ): AsyncGenerator<unknown> {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { input: options.input };
      } finally {
        activeCalls -= 1;
      }
    };
    streamAccountTool.mockImplementationOnce(concurrentStream);
    streamAccountTool.mockImplementationOnce(concurrentStream);

    const result = await generateText({
      model: new MockLanguageModelV4({
        doGenerate: [
          {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "sandbox_tool",
                input: '{"message":"first"}',
              },
              {
                type: "tool-call",
                toolCallId: "call_2",
                toolName: "sandbox_tool",
                input: '{"message":"second"}',
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: modelUsage(),
            warnings: [],
          },
          {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: modelUsage(),
            warnings: [],
          },
        ],
      }),
      prompt: "Run both calls.",
      stopWhen: stepCountIs(2),
      tools: await accountToolSet(),
    });

    expect(maxActiveCalls).toBe(2);
    expect(result.steps[0]?.toolResults.map((entry) => entry.output)).toEqual([
      { input: { message: "first" } },
      { input: { message: "second" } },
    ]);
    expect(result.text).toBe("done");
  });
});

async function execute(input: Record<string, unknown>): Promise<unknown> {
  const tool = (await accountToolSet())["sandbox_tool"];
  if (!tool?.execute) throw new Error("adapter registered no execute");

  return await tool.execute(input, {
    toolCallId: "call_1",
    messages: [],
  } as never);
}

async function accountToolSet() {
  const accountTool = (await import("../src/harness/tools/custom.tool.ts"))
    .default;

  return accountTool(toolRecord(), {
    accountId: "acct_test",
    config: {},
  } as never);
}

function modelUsage(): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 1,
      text: 1,
      reasoning: 0,
    },
  };
}

function toolRecord(): AccountToolRecord {
  return {
    accountId: "acct_test",
    toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
    name: "sandbox_tool",
    description: "Uploaded sandbox tool.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
    sha256: "0".repeat(64),
    runtime: "sandbox",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}
