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
    }, new Set(["slowLookup"]));

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
    }, new Set(["googleSearch"]));

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
    }, new Set(["neverFinishes"]));

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
