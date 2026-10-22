import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { asyncToolResultDedupeKey } from "@broods/convex/model/subagentResults";
import { jsonSchema, tool, type UserModelMessage } from "ai";
import * as asyncToolResults from "../src/harness/async-tool-result.ts";
import type { AsyncToolResultRecord } from "../src/harness/async-tool-result.ts";
import type { ContinuationOutcome } from "../src/harness/responses.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import * as log from "../src/shared/log.ts";

const originalMutation = runtime.mutate.bind(runtime);
const mutationMock = mock(
  async (name: string, _args: Record<string, unknown>) =>
    name === "createAsyncToolResult" ? true : null,
);
type TestToolExecute = {
  execute(
    input: unknown,
    options: { toolCallId: string; messages: []; context: undefined },
  ): Promise<unknown>;
};

afterEach(() => {
  runtime.mutate = originalMutation;
  mutationMock.mockClear();
});

describe("AsyncToolCoordinator", () => {
  it("injects file and image outputs as native user file parts", async () => {
    const { completionToParentMessage } =
      await import("../src/harness/async-tools.ts");
    const message = completionToParentMessage({
      resultId: "async_tool_1",
      toolName: "render",
      input: {},
      status: "completed",
      response: {
        type: "content",
        value: [
          {
            type: "file-data",
            data: "JVBERi0=",
            mediaType: "application/pdf",
            filename: "report.pdf",
          },
          {
            type: "image-url",
            url: "https://example.com/preview.png",
          },
        ],
      },
    });

    expect(message.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Async tool result injected"),
      },
      {
        type: "file",
        data: { type: "data", data: "JVBERi0=" },
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
      {
        type: "file",
        data: {
          type: "url",
          url: new URL("https://example.com/preview.png"),
        },
        mediaType: "image",
      },
    ]);
  });

  it("preserves binary and URL file parts across async persistence", async () => {
    runtime.mutate = mutationMock as never;
    const { AsyncToolCoordinator } =
      await import("../src/harness/async-tools.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]) => [],
    );
    const coordinator = new AsyncToolCoordinator(
      {
        conversationKey: "conversation-1",
        eventId: "event-1",
        persistModelMessages: persistModelMessages,
      } as never,
      Date.now() + 1_000,
    );
    const arrayBuffer = new Uint8Array([3, 4]).buffer;
    const tools = coordinator.dispatch(
      {
        attachments: tool({
          description: "Return attachments.",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => ({
            type: "content" as const,
            value: [
              {
                type: "file" as const,
                data: {
                  type: "data" as const,
                  data: new Uint8Array([1, 2]),
                },
                mediaType: "application/octet-stream",
                filename: "bytes.bin",
              },
              {
                type: "file" as const,
                data: { type: "data" as const, data: arrayBuffer },
                mediaType: "application/octet-stream",
                filename: "buffer.bin",
              },
              {
                type: "file" as const,
                data: {
                  type: "url" as const,
                  url: new URL("https://example.com/report.pdf"),
                },
                mediaType: "application/pdf",
              },
            ],
          }),
        }),
      },
      new Set(["attachments"]),
    );

    const pending = await (
      tools.attachments as unknown as TestToolExecute
    ).execute(
      {},
      { toolCallId: "tool-call-files", messages: [], context: undefined },
    );
    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);

    const resultId = (pending as { resultId: string }).resultId;
    const persisted = {
      type: "content",
      value: [
        {
          type: "file-data",
          data: "AQI=",
          mediaType: "application/octet-stream",
          filename: "bytes.bin",
        },
        {
          type: "file-data",
          data: "AwQ=",
          mediaType: "application/octet-stream",
          filename: "buffer.bin",
        },
        {
          type: "file-url",
          url: "https://example.com/report.pdf",
          mediaType: "application/pdf",
        },
      ],
    };
    expect(mutationMock).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: resultId,
      status: "completed",
      response: persisted,
      onlyWhenProcessing: true,
    });
    const content = persistModelMessages.mock.calls[0]?.[0]?.[0]?.content;
    expect(content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Async tool result injected"),
      },
      {
        type: "file",
        data: { type: "data", data: "AQI=" },
        mediaType: "application/octet-stream",
        filename: "bytes.bin",
      },
      {
        type: "file",
        data: { type: "data", data: "AwQ=" },
        mediaType: "application/octet-stream",
        filename: "buffer.bin",
      },
      {
        type: "file",
        data: {
          type: "url",
          url: new URL("https://example.com/report.pdf"),
        },
        mediaType: "application/pdf",
      },
    ]);
  });

  it("returns a pending result immediately and injects the completed output later", async () => {
    runtime.mutate = mutationMock as never;
    const { AsyncToolCoordinator } =
      await import("../src/harness/async-tools.ts");
    const persistModelMessages = mock(
      async (
        _messages: UserModelMessage[],
        _onSaved?: (saved: number) => void,
        _dedupeKeys?: string[],
      ): Promise<string[]> => [],
    );
    let finishTool!: (value: unknown) => void;
    const coordinator = new AsyncToolCoordinator(
      {
        conversationKey: "conversation-1",
        eventId: "event-1",
        persistModelMessages: persistModelMessages,
      } as never,
      Date.now() + 1_000,
    );

    const tools = coordinator.dispatch(
      {
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
      },
      new Set(["slowLookup"]),
    );

    const pending = await (
      tools.slowLookup as unknown as TestToolExecute
    ).execute(
      { query: "alpha" },
      { toolCallId: "tool-call-1", messages: [], context: undefined },
    );

    expect(pending).toEqual({
      resultId: expect.stringMatching(/^async_tool_/),
      status: "running",
    });
    const resultId = (pending as { resultId: string }).resultId;
    expect(coordinator.pendingCount).toBe(1);
    expect(mutationMock.mock.calls[0]).toEqual([
      "createAsyncToolResult",
      {
        resultId: resultId,
        parentEventId: "event-1",
        conversationKey: "conversation-1",
        toolName: "slowLookup",
        toolCallId: "tool-call-1",
        input: { query: "alpha" },
      },
    ]);

    finishTool(undefined);
    expect(coordinator.waitForIdle()).resolves.toBe("idle");
    expect(coordinator.drainCompletionsToParent()).resolves.toBe(1);

    expect(mutationMock).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: resultId,
      status: "completed",
      response: { answer: "result for alpha" },
      onlyWhenProcessing: true,
    });
    // Written under its hand-back key, so the insert marks the row stored.
    expect(persistModelMessages.mock.calls[0]?.[2]).toEqual([
      asyncToolResultDedupeKey(resultId, "completed"),
    ]);
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain(
      "Async tool result injected into parent conversation.",
    );
    expect(messageText(messages[0])).toContain("toolName: slowLookup");
    expect(messageText(messages[0])).toContain("result for alpha");
  });

  it("keeps provider-defined tools without local execute unchanged", async () => {
    runtime.mutate = mutationMock as never;
    const { AsyncToolCoordinator } =
      await import("../src/harness/async-tools.ts");
    const coordinator = new AsyncToolCoordinator(
      {
        conversationKey: "conversation-1",
        eventId: "event-1",
        persistModelMessages: async () => [],
      } as never,
      Date.now() + 1_000,
    );
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

    const tools = coordinator.dispatch(
      {
        googleSearch: providerTool as never,
      },
      new Set(["googleSearch"]),
    );

    expect(tools.googleSearch as unknown).toBe(providerTool);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("injects timeout failures for pending async tool calls", async () => {
    runtime.mutate = mutationMock as never;
    const { AsyncToolCoordinator } =
      await import("../src/harness/async-tools.ts");
    const persistModelMessages = mock(
      async (_messages: UserModelMessage[]) => [],
    );
    const coordinator = new AsyncToolCoordinator(
      {
        conversationKey: "conversation-1",
        eventId: "event-1",
        persistModelMessages: persistModelMessages,
      } as never,
      Date.now(),
    );

    const tools = coordinator.dispatch(
      {
        neverFinishes: tool({
          description: "Never finishes.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: async () => await new Promise(() => {}),
        }),
      },
      new Set(["neverFinishes"]),
    );

    const pending = await (
      tools.neverFinishes as unknown as TestToolExecute
    ).execute(
      {},
      { toolCallId: "tool-call-2", messages: [], context: undefined },
    );
    const resultId = (pending as { resultId: string }).resultId;
    expect(mutationMock.mock.calls[0]).toEqual([
      "createAsyncToolResult",
      {
        resultId: resultId,
        parentEventId: "event-1",
        conversationKey: "conversation-1",
        toolName: "neverFinishes",
        toolCallId: "tool-call-2",
        input: {},
      },
    ]);

    expect(coordinator.waitForIdle()).resolves.toBe("timeout");
    expect(coordinator.drainCompletionsAndTimeoutsToParent()).resolves.toBe(1);

    expect(mutationMock).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: resultId,
      status: "failed",
      error:
        "Async tool call is still pending near the parent request timeout.",
      onlyWhenProcessing: true,
    });
    const messages = persistModelMessages.mock.calls[0]?.[0] ?? [];
    expect(messageText(messages[0])).toContain(
      "Async tool call is still pending near the parent request timeout.",
    );
  });

  it("marks each result detached when the parent write fails, and still fails the drain", async () => {
    runtime.mutate = mutationMock as never;
    const { AsyncToolCoordinator } =
      await import("../src/harness/async-tools.ts");
    const coordinator = new AsyncToolCoordinator(
      {
        conversationKey: "conversation-1",
        eventId: "event-1",
        persistModelMessages: mock(
          async (_messages: UserModelMessage[]): Promise<string[]> => {
            throw new Error("convex down");
          },
        ),
      } as never,
      Date.now() + 1_000,
    );
    const tools = coordinator.dispatch(
      {
        lookup: tool({
          description: "Lookup.",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => ({ answer: 42 }),
        }),
      },
      new Set(["lookup"]),
    );
    const pending = await (tools.lookup as unknown as TestToolExecute).execute(
      {},
      { toolCallId: "tool-call-3", messages: [], context: undefined },
    );
    const resultId = (pending as { resultId: string }).resultId;
    expect(coordinator.waitForIdle()).resolves.toBe("idle");

    expect(coordinator.drainCompletionsToParent()).rejects.toThrow(
      "convex down",
    );
    // The row holds the result; detached hands it to the recovery sweep.
    expect(mutationMock).toHaveBeenCalledWith("markAsyncToolHandback", {
      resultId: resultId,
      handback: "detached",
    });
  });
});

describe("resumeLostAsyncToolResults", () => {
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // A finished row no run delivered, `name` apart.
  const lostRow = (
    name: string,
    row: Partial<AsyncToolResultRecord>,
  ): AsyncToolResultRecord => ({
    resultId: `async_tool_${name}`,
    parentEventId: "acct:account_1:agent:agent_1:api:event_parent",
    conversationKey: "acct:account_1:agent:agent_1:api:chat",
    toolName: "lookup",
    toolCallId: `call-${name}`,
    input: {},
    status: "completed",
    response: `the answer of ${name}`,
    handback: "detached",
    createdAt: longAgo,
    updatedAt: longAgo,
    expiresAt: Date.now() + 60_000,
    ...row,
  });

  it("resumes each lost result once, keeps a full conversation's and a still queued one's for the next pass, and gives up on one nothing can resume", async (): Promise<void> => {
    const rows = [
      lostRow("resumed", {}),
      lostRow("queued", {}),
      lostRow("pending", { handback: "pending" }),
      lostRow("full", { status: "failed", error: "boom" }),
      lostRow("gone", { handback: "pending", status: "failed", error: "x" }),
    ];
    const windows: Array<{
      handback: string;
      status: string;
      updatedBefore: string;
    }> = [];
    const pages = spyOn(
      asyncToolResults,
      "listOwedAsyncToolResults",
    ).mockImplementation(
      async (options: {
        handback: string;
        status: string;
        updatedBefore: string;
      }): Promise<{
        page: AsyncToolResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => {
        windows.push({
          handback: options.handback,
          status: options.status,
          updatedBefore: options.updatedBefore,
        });

        return {
          page: rows.filter(
            (row): boolean =>
              row.handback === options.handback &&
              row.status === options.status,
          ),
          cursor: "end",
          isDone: true,
        };
      },
    );
    const marked = spyOn(
      asyncToolResults,
      "markAsyncToolHandback",
    ).mockResolvedValue(false);
    const info = spyOn(log, "logInfo");
    const outcomes: Record<string, ContinuationOutcome> = {
      async_tool_resumed: {
        kind: "ready",
        admission: "queued",
        invoked: false,
        publicEventId: "async-tools-async_tool_resumed",
      },
      // Its continuation still waits in the queue, which stores it when
      // applied, or admits the next pass's retry once it expired.
      async_tool_queued: {
        kind: "ready",
        admission: "duplicate",
        invoked: false,
        publicEventId: "async-tools-async_tool_queued",
      },
      async_tool_pending: {
        kind: "ready",
        admission: "owner",
        invoked: true,
        publicEventId: "async-tools-async_tool_pending",
      },
      async_tool_full: {
        kind: "ready",
        admission: "capacity",
        invoked: false,
        publicEventId: "async-tools-async_tool_full",
      },
      async_tool_gone: { kind: "skip" },
    };
    const resumed: string[] = [];
    const { resumeLostAsyncToolResults } =
      await import("../src/harness/async-tools.ts");

    try {
      await resumeLostAsyncToolResults(
        async (row: AsyncToolResultRecord): Promise<ContinuationOutcome> => {
          resumed.push(row.resultId);

          return outcomes[row.resultId]!;
        },
      );

      // Detached rows first, then pending, completed before failed in each.
      expect(windows.map((window) => [window.handback, window.status])).toEqual(
        [
          ["detached", "completed"],
          ["detached", "failed"],
          ["pending", "completed"],
          ["pending", "failed"],
        ],
      );
      // A pending result waits out the run's whole hold, longer than the
      // grace a detached one gets.
      expect(windows[2]!.updatedBefore < windows[0]!.updatedBefore).toBe(true);
      expect(resumed).toEqual([
        "async_tool_resumed",
        "async_tool_queued",
        "async_tool_full",
        "async_tool_pending",
        "async_tool_gone",
      ]);
      // Only the row nothing can resume is given up; a full conversation and
      // a queued continuation keep their rows for the next pass, and the
      // others are stored by their admission.
      expect(marked.mock.calls).toEqual([["async_tool_gone", "stored"]]);
      expect(
        info.mock.calls
          .filter(
            ([message]): boolean =>
              message === "Async tool result left pending past the run's hold",
          )
          .map(([, data]) => (data as { resultId: string }).resultId),
      ).toEqual(["async_tool_pending", "async_tool_gone"]);
    } finally {
      pages.mockRestore();
      marked.mockRestore();
      info.mockRestore();
    }
  });
});

describe("async_status", () => {
  it("hands a settled result over unless its continuation already waits in the queue", async (): Promise<void> => {
    const conversationKey = "acct:account_1:agent:agent_1:api:chat";
    const row: AsyncToolResultRecord = {
      resultId: "async_tool_read",
      parentEventId: "acct:account_1:agent:agent_1:api:event_parent",
      conversationKey: conversationKey,
      toolName: "lookup",
      toolCallId: "call-read",
      input: {},
      status: "completed",
      response: "the answer",
      handback: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: Date.now() + 60_000,
    };
    const read = spyOn(
      asyncToolResults,
      "getAsyncToolResult",
    ).mockResolvedValue(row);
    // Queued first, so the read leaves it to the continuation; then not.
    const marked = spyOn(asyncToolResults, "markAsyncToolHandback")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { default: asyncStatusTool } =
      await import("../src/harness/tools/async-status.tool.ts");
    const tools = asyncStatusTool({
      conversationKey: conversationKey,
      supportsJobs: false,
    });
    const check = (): Promise<unknown> =>
      (tools.async_status as unknown as TestToolExecute).execute(
        { statusId: row.resultId },
        { toolCallId: "tool-call-read", messages: [], context: undefined },
      );

    try {
      expect(await check()).toEqual({
        status: "completed",
        delivery: "automatic",
      });
      expect(await check()).toEqual({
        status: "completed",
        response: "the answer",
      });
      expect(marked.mock.calls).toEqual([
        [row.resultId, "stored"],
        [row.resultId, "stored"],
      ]);
    } finally {
      read.mockRestore();
      marked.mockRestore();
    }
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
