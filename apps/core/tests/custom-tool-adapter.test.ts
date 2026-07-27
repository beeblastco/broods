/**
 * The AI SDK adapter for uploaded tools, driven through the SDK's own tool loop.
 * Every yield must reach the SDK as a preliminary tool result and survive the
 * wrappers the harness puts around execute — an `async` wrapper anywhere in that
 * chain turns the generator into a Promise the SDK hands back unread, which is
 * how uploaded tools once returned `{}` without ever running the bundle.
 */

import { describe, expect, it, mock } from "bun:test";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { executeTool } from "@ai-sdk/provider-utils";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ExecuteAccountToolOptions } from "../src/harness/bundles/payload.ts";
import {
  wrapToolsWithHooks,
  type HookDispatcher,
} from "../src/harness/hook-dispatcher.ts";
import { wrapToolsWithOwnerFence } from "../src/harness/tool-execute.ts";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";

const streamAccountTool = mock(async function* (
  _options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown> {
  yield { step: 1 };
  yield { done: true };
});

mock.module("../src/harness/bundles/executor.ts", () => ({
  streamAccountTool: streamAccountTool,
}));

describe("accountTool adapter", () => {
  it("streams every yield as a preliminary result, then the last as final", async () => {
    const parts = await run(await accountToolSet());

    expect(parts).toEqual([
      { type: "preliminary", output: { step: 1 } },
      { type: "preliminary", output: { done: true } },
      { type: "final", output: { done: true } },
    ]);
  });

  it("keeps streaming through the owner fence", async () => {
    let fenced = 0;
    const parts = await run(
      wrapToolsWithOwnerFence(await accountToolSet(), {
        assertCurrentOwner: async () => {
          fenced++;
        },
      }),
    );

    // A lone `{type:"final", output:{}}` here is the regression: the fence
    // awaited the generator instead of iterating it.
    expect(fenced).toBe(1);
    expect(parts.filter((part) => part.type === "preliminary")).toHaveLength(2);
    expect(parts.at(-1)).toEqual({ type: "final", output: { done: true } });
  });

  it("keeps streaming through the tool hooks wrapper", async () => {
    const parts = await run(
      wrapToolsWithHooks(await accountToolSet(), hooks()),
    );

    expect(parts.filter((part) => part.type === "preliminary")).toHaveLength(2);
    expect(parts.at(-1)).toEqual({ type: "final", output: { done: true } });
  });

  it("lets a tool.result hook rewrite the final value of a streaming tool", async () => {
    const parts = await run(
      wrapToolsWithHooks(
        await accountToolSet(),
        hooks({ output: { rewritten: true } }),
      ),
    );

    expect(parts.at(-1)).toEqual({
      type: "final",
      output: { rewritten: true },
    });
  });

  it("leaves a non-streaming tool with no preliminary results", async () => {
    const plain = {
      plain_tool: {
        inputSchema: { jsonSchema: { type: "object" } },
        execute: async () => ({ ok: true }),
      },
    } as unknown as ToolSet;
    const parts = await run(
      wrapToolsWithOwnerFence(plain, { assertCurrentOwner: async () => {} }),
      "plain_tool",
    );

    expect(parts).toEqual([{ type: "final", output: { ok: true } }]);
  });

  it("surfaces a failing bundle instead of swallowing it", async () => {
    streamAccountTool.mockImplementationOnce(
      async function* (): AsyncGenerator<unknown> {
        throw new Error("bundle blew up");
      },
    );

    await expect(run(await accountToolSet())).rejects.toThrow("bundle blew up");
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

async function accountToolSet(): Promise<ToolSet> {
  const accountTool = (await import("../src/harness/tools/custom.tool.ts"))
    .default;

  return accountTool(toolRecord(), {
    accountId: "acct_test",
    config: {},
  } as never);
}

async function run(
  tools: ToolSet,
  name = "sandbox_tool",
): Promise<Array<{ type: string; output: unknown }>> {
  const tool = tools[name];
  if (!tool?.execute) throw new Error("adapter registered no execute");
  const parts: Array<{ type: string; output: unknown }> = [];
  for await (const part of executeTool({
    tool: tool as never,
    input: { message: "hi" } as never,
    options: { toolCallId: "call_1", messages: [] } as never,
  })) {
    parts.push(part as { type: string; output: unknown });
  }

  return parts;
}

function hooks(resultMutation?: { output: unknown }): HookDispatcher {
  return {
    hasHooksFor: (event: string) => event === "tool.result",
    runMutation: async () => resultMutation,
  } as unknown as HookDispatcher;
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
