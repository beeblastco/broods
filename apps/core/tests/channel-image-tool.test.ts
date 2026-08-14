/**
 * send-image workspace delivery tests.
 * Cover handing a workspace file to a channel that only fetches public URLs.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecuteFunction, ToolSet } from "ai";
import type { ChannelToolContext } from "../src/harness/tools/channel.tool.ts";

const getS3ObjectUrlMock = mock(
  async (_bucket: string, _key: string) => "https://signed.example/photo",
);
const s3ObjectExistsMock = mock(async (_bucket: string, _key: string) => true);

mock.module("../src/shared/s3.ts", () => ({
  getS3ObjectUrl: getS3ObjectUrlMock,
  s3ObjectExists: s3ObjectExistsMock,
  // Full surface so transitive importers keep working (mock.module replaces the module).
  readS3Text: mock(async () => ""),
  readS3Bytes: mock(async () => new Uint8Array()),
  listS3Prefix: mock(async () => []),
  writeS3Object: mock(async () => 0),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  isMissingS3Error: () => false,
}));

const ORIGINAL_ENV = { ...process.env };
const NS = "fs-0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  getS3ObjectUrlMock.mockClear();
  s3ObjectExistsMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  s3ObjectExistsMock.mockImplementation(async () => true);
});

describe("sendImageTool", () => {
  it("sends a workspace file as a presigned URL", async (): Promise<void> => {
    const { sendImageTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const sendImage = mock(async function (): Promise<void> {});
    const tools = sendImageTool(channelContext(sendImage));

    const result = await execute(tools["send-image"], {
      file_path: "profile.jpeg",
      caption: "here you go",
    });

    expect(s3ObjectExistsMock.mock.calls[0]).toEqual([
      "filesystem-bucket",
      `${NS}/profile.jpeg`,
    ]);
    expect(sendImage).toHaveBeenCalledWith(
      "https://signed.example/photo",
      "[safe] here you go",
    );
    expect(result).toContain("Image sent");
  });

  it("reports a missing workspace file instead of sending", async (): Promise<void> => {
    const { sendImageTool } =
      await import("../src/harness/tools/channel.tool.ts");
    s3ObjectExistsMock.mockImplementation(async () => false);
    const sendImage = mock(async function (): Promise<void> {});
    const tools = sendImageTool(channelContext(sendImage));

    const sent = execute(tools["send-image"], { file_path: "missing.png" });

    await expect(sent).rejects.toThrow("Error: file not found: missing.png");
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("requires either a workspace file or a URL", async (): Promise<void> => {
    const { sendImageTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const sendImage = mock(async function (): Promise<void> {});
    const tools = sendImageTool(channelContext(sendImage));

    const sent = execute(tools["send-image"], { caption: "no image" });

    await expect(sent).rejects.toThrow("send-image needs either file_path");
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("offers no workspace file path when no workspace is attached", async (): Promise<void> => {
    const { sendImageTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const context = channelContext(mock(async function (): Promise<void> {}));
    const tools = sendImageTool({ ...context, workspaces: [] });
    const schema = tools["send-image"]!.inputSchema as {
      jsonSchema: { properties: Record<string, unknown> };
    };

    expect(Object.keys(schema.jsonSchema.properties)).toEqual([
      "url",
      "caption",
    ]);
  });
});

function channelContext(
  sendImage: (url: string, caption?: string) => Promise<void>,
): ChannelToolContext {
  return {
    actions: {
      sendImage: sendImage,
      sendText: async function (): Promise<void> {},
      sendTyping: async function (): Promise<void> {},
      reactToMessage: async function (): Promise<void> {},
    },
    channelName: "zalo",
    transformText: async function (text: string): Promise<string> {
      return `[safe] ${text}`;
    },
    workspaces: [
      {
        name: "notes",
        workspaceId: "ws_a",
        namespace: NS,
        config: { storage: { provider: "s3" } },
      },
    ] as never,
  };
}

async function execute(
  tool: ToolSet[string] | undefined,
  input: Record<string, unknown>,
): Promise<string> {
  const execute = tool?.execute as ToolExecuteFunction<
    Record<string, unknown>,
    unknown,
    Record<string, unknown>
  >;

  return (await execute(input, {
    toolCallId: "channel-image-test",
    messages: [],
    context: {},
  })) as string;
}
