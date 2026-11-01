import { describe, expect, it, spyOn } from "bun:test";
import * as asyncToolResults from "../src/harness/async-tool-result.ts";
import type { AsyncToolResultRecord } from "../src/harness/async-tool-result.ts";
import type { ContinuationOutcome } from "../src/harness/responses.ts";
import * as log from "../src/shared/log.ts";

type TestToolExecute = {
  execute(
    input: unknown,
    options: { toolCallId: string; messages: []; context: undefined },
  ): Promise<unknown>;
};

describe("completionToParentMessage", () => {
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
