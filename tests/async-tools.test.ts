/**
 * Async external tool coordinator tests.
 * Cover result persistence and parent-message injection without provider calls.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { jsonSchema, tool, type UserModelMessage } from "ai";
import { dynamo } from "../functions/_shared/dynamo.ts";

process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-result";

const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("AsyncToolCoordinator", () => {
  it("returns a pending result immediately and injects the completed output later", async () => {
    dynamo.send = sendMock as never;
    const { AsyncToolCoordinator } = await import("../functions/harness-processing/async-tools.ts");
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
    }, new Map([["slowLookup", "same-invocation" as const]]));

    const pending = await (tools.slowLookup as {
      execute(input: unknown, options: { toolCallId: string; messages: [] }): Promise<unknown>;
    }).execute({ query: "alpha" }, { toolCallId: "tool-call-1", messages: [] });

    expect(pending).toMatchObject({
      toolName: "slowLookup",
      toolCallId: "tool-call-1",
      status: "running",
      statusReference: {
        table: "AsyncToolResult",
      },
    });
    expect(coordinator.pendingCount).toBe(1);
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(PutItemCommand);

    finishTool(undefined);
    await expect(coordinator.waitForIdle()).resolves.toBe("idle");
    await expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);

    expect(sendMock.mock.calls.some(([command]) =>
      command instanceof UpdateItemCommand &&
      command.input.ExpressionAttributeValues?.[":status"]?.S === "completed"
    )).toBe(true);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain("Async tool result injected into parent conversation.");
    expect(messageText(messages[0])).toContain("toolName: slowLookup");
    expect(messageText(messages[0])).toContain("result for alpha");
  });

  it("keeps provider-defined tools without local execute unchanged", async () => {
    dynamo.send = sendMock as never;
    const { AsyncToolCoordinator } = await import("../functions/harness-processing/async-tools.ts");
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
    }, new Map([["googleSearch", "same-invocation" as const]]));

    expect(tools.googleSearch as unknown).toBe(providerTool);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("injects timeout failures for pending async tool calls", async () => {
    dynamo.send = sendMock as never;
    const { AsyncToolCoordinator } = await import("../functions/harness-processing/async-tools.ts");
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
    }, new Map([["neverFinishes", "same-invocation" as const]]));

    await (tools.neverFinishes as {
      execute(input: unknown, options: { toolCallId: string; messages: [] }): Promise<unknown>;
    }).execute({}, { toolCallId: "tool-call-2", messages: [] });

    await expect(coordinator.waitForIdle()).resolves.toBe("timeout");
    await expect(coordinator.drainCompletionsAndTimeoutsToParent()).resolves.toBe(1);

    expect(sendMock.mock.calls.some(([command]) =>
      command instanceof UpdateItemCommand &&
      command.input.ExpressionAttributeValues?.[":status"]?.S === "failed"
    )).toBe(true);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain("Async tool call is still pending near the parent request timeout.");
  });

  it("uses external-dispatch mode without starting tracked background work", async () => {
    dynamo.send = sendMock as never;
    const { AsyncToolCoordinator } = await import("../functions/harness-processing/async-tools.ts");
    const persistModelMessages = mock(async (_messages: UserModelMessage[]) => []);
    let finishTool!: (value: unknown) => void;
    let executeReturned = false;
    let asyncToolMetadata: { resultId?: string; statusReference?: { resultId?: string } } | undefined;
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages,
    } as never, Date.now() + 1_000, new Set(["external-dispatch"] as const), {
      kind: "nats",
      connectionId: "connection-1",
      publicEventId: "event-public-1",
      publicConversationKey: "conversation-public-1",
    });

    const tools = coordinator.dispatch({
      externalLookup: tool({
        description: "External lookup.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: async (_input, options) => {
          asyncToolMetadata = (options as { asyncTool?: typeof asyncToolMetadata }).asyncTool;
          await new Promise((resolve) => {
            finishTool = resolve;
          });
          return { answer: "late result" };
        },
      }),
    }, new Map([["externalLookup", "external-dispatch" as const]]));

    const pendingPromise = (tools.externalLookup as {
      execute(input: unknown, options: { toolCallId: string; messages: [] }): Promise<unknown>;
    }).execute({}, { toolCallId: "tool-call-3", messages: [] }).then((result) => {
      executeReturned = true;
      return result;
    });

    await sleep(0);
    expect(coordinator.pendingCount).toBe(0);
    expect(coordinator.hasExternalDispatches).toBe(true);
    expect(executeReturned).toBe(false);
    expect(asyncToolMetadata?.resultId?.startsWith("async_tool_")).toBe(true);
    expect(asyncToolMetadata?.statusReference?.resultId).toBe(asyncToolMetadata?.resultId);
    expect(persistModelMessages).not.toHaveBeenCalled();

    finishTool(undefined);
    await expect(pendingPromise).resolves.toMatchObject({
      toolName: "externalLookup",
      toolCallId: "tool-call-3",
      status: "running",
    });

    expect(executeReturned).toBe(true);
    expect(persistModelMessages).not.toHaveBeenCalled();
    expect(sendMock.mock.calls.some(([command]) =>
      command instanceof UpdateItemCommand &&
      command.input.ExpressionAttributeValues?.[":status"]
    )).toBe(false);
    const putCommand = sendMock.mock.calls.find(([command]) => command instanceof PutItemCommand)?.[0];
    expect(putCommand).toBeInstanceOf(PutItemCommand);
    if (!(putCommand instanceof PutItemCommand)) {
      throw new Error("Expected PutItemCommand");
    }
    expect(putCommand.input.Item?.delivery).toEqual({
      M: {
        kind: { S: "nats" },
        connectionId: { S: "connection-1" },
        publicEventId: { S: "event-public-1" },
        publicConversationKey: { S: "conversation-public-1" },
      },
    });
    const groupCommand = sendMock.mock.calls.find(([command]) =>
      command instanceof UpdateItemCommand &&
      command.input.ExpressionAttributeValues?.[":itemType"]?.S === "external-dispatch-group"
    )?.[0];
    expect(groupCommand).toBeInstanceOf(UpdateItemCommand);
  });

  it("rejects same-invocation async tools when only external dispatch is supported", async () => {
    dynamo.send = sendMock as never;
    const { AsyncToolCoordinator } = await import("../functions/harness-processing/async-tools.ts");
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages: async () => [],
    } as never, Date.now() + 1_000, new Set(["external-dispatch"] as const));

    expect(() => coordinator.dispatch({
      slowLookup: tool({
        description: "Slow lookup.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => ({ ok: true }),
      }),
    }, new Map([["slowLookup", "same-invocation" as const]]))).toThrow(
      "Async tool slowLookup uses same-invocation, which is not supported by this request path",
    );
  });

  it("allows same-invocation and external-dispatch tools in detached request paths", async () => {
    dynamo.send = sendMock as never;
    const { AsyncToolCoordinator } = await import("../functions/harness-processing/async-tools.ts");
    const coordinator = new AsyncToolCoordinator({
      conversationKey: "conversation-1",
      eventId: "event-1",
      persistModelMessages: async () => [],
    } as never, Date.now() + 1_000, new Set(["same-invocation", "external-dispatch"] as const), { kind: "async" });
    let finishSameInvocation!: (value: unknown) => void;

    const tools = coordinator.dispatch({
      sameInvocation: tool({
        description: "Same invocation.",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => {
          await new Promise((resolve) => {
            finishSameInvocation = resolve;
          });
          return { ok: true };
        },
      }),
      externalDispatch: tool({
        description: "External dispatch.",
        inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ dispatched: true }),
      }),
    }, new Map([
      ["sameInvocation", "same-invocation" as const],
      ["externalDispatch", "external-dispatch" as const],
    ]));

    await expect((tools.sameInvocation as {
      execute(input: unknown, options: { toolCallId: string; messages: [] }): Promise<unknown>;
    }).execute({}, { toolCallId: "tool-call-4", messages: [] })).resolves.toMatchObject({
      toolName: "sameInvocation",
      status: "running",
    });
    await expect((tools.externalDispatch as {
      execute(input: unknown, options: { toolCallId: string; messages: [] }): Promise<unknown>;
    }).execute({}, { toolCallId: "tool-call-5", messages: [] })).resolves.toMatchObject({
      toolName: "externalDispatch",
      status: "running",
    });

    expect(coordinator.pendingCount).toBe(1);
    expect(coordinator.hasExternalDispatches).toBe(true);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
