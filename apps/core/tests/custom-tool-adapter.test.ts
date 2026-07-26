/**
 * The AI SDK adapter for uploaded tools. It must resolve the executor's stream
 * to a value: the SDK takes execute()'s return as the tool result, so returning
 * the async generator itself serialized to `{}` and the bundle never ran.
 */

import { describe, expect, it, mock } from "bun:test";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";

const streamAccountTool = mock(async function* (): AsyncGenerator<unknown> {
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
});

async function execute(input: Record<string, unknown>): Promise<unknown> {
  const accountTool = (await import("../src/harness/tools/custom.tool.ts"))
    .default;
  const tools = accountTool(toolRecord(), {
    accountId: "acct_test",
    config: {},
  } as never);
  const tool = tools["sandbox_tool"];
  if (!tool?.execute) throw new Error("adapter registered no execute");

  return await tool.execute(input, {
    toolCallId: "call_1",
    messages: [],
  } as never);
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
