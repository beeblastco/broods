/**
 * Async tool coordinator tests.
 * Cover result persistence and parent-message injection without provider calls.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { jsonSchema, tool, type UserModelMessage } from "ai";
import { runtimePersistence } from "../src/shared/storage/convex/runtime.ts";

const originalMutation = runtimePersistence.mutation;
const mutationMock = mock(async (name: string, _args: Record<string, unknown>) =>
  name === "createAsyncToolResult" ? true : null);
type TestToolExecute = {
  execute(input: unknown, options: { toolCallId: string; messages: []; context: undefined }): Promise<unknown>;
};

afterEach(() => {
  runtimePersistence.mutation = originalMutation;
  mutationMock.mockClear();
});

describe("AsyncToolCoordinator", () => {
  it("returns a pending result immediately and injects the completed output later", async () => {
    runtimePersistence.mutation = mutationMock as never;
    const { AsyncToolCoordinator } = await import("../src/harness/async-tools.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    let finishTool!: (value: unknown) => void;
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages,
    } as never, Date.now() + 1_000);

    const tools = coordinator.dispatch({
      slowLookup: tool({
        description: "Slow lookup.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
          additionalProperties: false,
        }),
        execute: async ({ query }: { query: string }) => {
          await new Promise((resolve) => {
            finishTool = resolve;
          });
          return { answer: `result for ${query}` };
        },
      }),
    }, new Map([["slowLookup", "built-in" as const]]));

    const pending = await (tools.slowLookup as unknown as TestToolExecute).execute(
      { query: "alpha" },
      { toolCallId: "tool-call-1", messages: [], context: undefined },
    );

    expect(pending).toEqual({
      resultId: expect.stringMatching(/^async_tool_/),
      status: "running",
    });
    expect(coordinator.pendingCount).toBe(1);
    expect(mutationMock.mock.calls[0]?.[0]).toBe("createAsyncToolResult");

    finishTool(undefined);
    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
    await expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);

    expect(mutationMock.mock.calls.some(([name, args]) =>
      name === "updateAsyncToolResult" && args.status === "completed"
    )).toBe(true);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain("Async tool result injected into parent conversation.");
    expect(messageText(messages[0])).toContain("toolName: slowLookup");
    expect(messageText(messages[0])).toContain("result for alpha");
  });

  it("keeps provider-defined tools without local execute unchanged", async () => {
    runtimePersistence.mutation = mutationMock as never;
    const { AsyncToolCoordinator } = await import("../src/harness/async-tools.ts");
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages: async () => [],
    } as never, Date.now() + 1_000);
    const providerTool = {
      type: "provider",
      id: "google.google_search",
      args: {},
      inputSchema: jsonSchema({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    };

    const tools = coordinator.dispatch({
      googleSearch: providerTool as never,
    }, new Map([["googleSearch", "built-in" as const]]));

    expect(tools.googleSearch as unknown).toBe(providerTool);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("injects timeout failures for pending async tool calls", async () => {
    runtimePersistence.mutation = mutationMock as never;
    const { AsyncToolCoordinator } = await import("../src/harness/async-tools.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages,
    } as never, Date.now());

    const tools = coordinator.dispatch({
      neverFinishes: tool({
        description: "Never finishes.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => await new Promise(() => {}),
      }),
    }, new Map([["neverFinishes", "built-in" as const]]));

    await (tools.neverFinishes as unknown as TestToolExecute).execute(
      {},
      { toolCallId: "tool-call-2", messages: [], context: undefined },
    );

    await expect(coordinator.waitForIdle()).resolves.toBe("timeout");
    await expect(coordinator.drainCompletionsAndTimeoutsToParent()).resolves.toBe(1);

    expect(mutationMock.mock.calls.some(([name, args]) =>
      name === "updateAsyncToolResult" && args.status === "failed"
    )).toBe(true);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain("Async tool call is still pending near the parent request timeout.");
  });

  it("detaches uploaded async tools on delivered request paths", async () => {
    runtimePersistence.mutation = mutationMock as never;
    const { AsyncToolCoordinator } = await import("../src/harness/async-tools.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    let asyncToolMetadata: {
      resultId?: string;
      completePath?: string;
      completionToken?: string;
      detached?: boolean;
    } | undefined;
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages,
    } as never, Date.now() + 1_000, {
      kind: "nats",
      connectionId: "connection-1",
      publicEventId: "event-public-1",
      publicConversationKey: "conversation-public-1",
    });

    const tools = coordinator.dispatch({
      uploadedLookup: tool({
        description: "Uploaded lookup.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: async (_input, options) => {
          asyncToolMetadata = (options as { asyncTool?: typeof asyncToolMetadata }).asyncTool;
          return { started: true };
        },
      }),
    }, new Map([["uploadedLookup", "uploaded" as const]]));

    const pending = await (tools.uploadedLookup as unknown as TestToolExecute).execute(
      {},
      { toolCallId: "tool-call-3", messages: [], context: undefined },
    );

    expect(coordinator.pendingCount).toBe(0);
    expect(coordinator.hasDetachedCallbacks).toBe(true);
    expect(asyncToolMetadata?.resultId?.startsWith("async_tool_")).toBe(true);
    expect(asyncToolMetadata?.detached).toBe(true);
    expect(asyncToolMetadata?.completePath).toBe(`/sandbox-jobs/${encodeURIComponent(asyncToolMetadata?.resultId ?? "")}/complete`);
    expect(typeof asyncToolMetadata?.completionToken).toBe("string");
    expect(persistModelMessages).not.toHaveBeenCalled();
    expect(pending).toEqual({
      resultId: asyncToolMetadata?.resultId,
      status: "running",
    });

    expect(persistModelMessages).not.toHaveBeenCalled();
    expect(mutationMock.mock.calls.some(([name]) => name === "updateAsyncToolResult")).toBe(false);
    const createArgs = mutationMock.mock.calls.find(([name]) => name === "createAsyncToolResult")?.[1];
    expect(createArgs?.delivery).toEqual({
      kind: "nats",
      connectionId: "connection-1",
      publicEventId: "event-public-1",
      publicConversationKey: "conversation-public-1",
    });
    expect(createArgs?.completionToken).toBe(asyncToolMetadata?.completionToken);
  });

  it("waits for built-in tools but detaches uploaded tools in delivered request paths", async () => {
    runtimePersistence.mutation = mutationMock as never;
    const { AsyncToolCoordinator } = await import("../src/harness/async-tools.ts");
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages: async () => [],
    } as never, Date.now() + 1_000, { kind: "async" });
    let finishSameInvocation!: (value: unknown) => void;

    const tools = coordinator.dispatch({
      builtInAsync: tool({
        description: "Built-in async.",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => {
          await new Promise((resolve) => {
            finishSameInvocation = resolve;
          });
          return { ok: true };
        },
      }),
      uploadedAsync: tool({
        description: "Uploaded async.",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ started: true }),
      }),
    }, new Map([
      ["builtInAsync", "built-in" as const],
      ["uploadedAsync", "uploaded" as const],
    ]));

    await expect((tools.builtInAsync as unknown as TestToolExecute).execute(
      {},
      { toolCallId: "tool-call-4", messages: [], context: undefined },
    )).resolves.toMatchObject({
      status: "running",
    });
    await expect((tools.uploadedAsync as unknown as TestToolExecute).execute(
      {},
      { toolCallId: "tool-call-5", messages: [], context: undefined },
    )).resolves.toMatchObject({
      status: "running",
    });

    expect(coordinator.pendingCount).toBe(1);
    expect(coordinator.hasDetachedCallbacks).toBe(true);
    finishSameInvocation(undefined);
    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
  });
});

function messageText(message: UserModelMessage | undefined): string {
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  const part = content[0];
  return part?.type === "text" ? part.text : "";
}
