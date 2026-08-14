/**
 * send-image workspace delivery tests.
 * Cover handing a workspace file to a channel that only fetches public URLs.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecuteFunction, ToolSet } from "ai";
import type { ChannelToolContext } from "../src/harness/tools/channel.tool.ts";
import { openMediaTicket } from "../src/shared/media-ticket.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const s3ObjectExistsMock = mock(async (_bucket: string, _key: string) => true);

mock.module("../src/shared/s3.ts", () => ({
  s3ObjectExists: s3ObjectExistsMock,
  // Full surface so transitive importers keep working (mock.module replaces the module).
  headS3Object: mock(async () => ({
    contentLength: 1,
    contentType: "image/png",
  })),
  getS3ObjectUrl: mock(async () => "https://signed.example/photo"),
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
const ACCOUNT = "acct_1";
const NS = "fs-0123456789abcdef0123456789abcdef01234567";
const SECRET = "service-auth-secret";
const WORKSPACE: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_a",
  namespace: NS,
  config: { storage: { provider: "s3" } },
};

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.PUBLIC_BASE_URL = "https://gateway.test";
  process.env.SERVICE_AUTH_SECRET = SECRET;
  s3ObjectExistsMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  s3ObjectExistsMock.mockImplementation(async () => true);
});

describe("sendImageTool", () => {
  it("sends a workspace file as a durable media link", async (): Promise<void> => {
    const { sendImageTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sentUrl = "";
    let sentCaption: string | undefined;
    const tools = sendImageTool(
      channelContext(async function (url, caption): Promise<void> {
        sentUrl = url;
        sentCaption = caption;
      }),
    );

    const result = await execute(tools["send-image"], {
      file_path: "profile.jpeg",
      caption: "here you go",
    });

    expect(s3ObjectExistsMock.mock.calls[0]).toEqual([
      "filesystem-bucket",
      `${NS}/profile.jpeg`,
    ]);
    expect(sentCaption).toBe("[safe] here you go");
    expect(sentUrl.startsWith("https://gateway.test/media/")).toBe(true);
    // The link must survive on its own: everything the media route needs to find
    // the file again is sealed into the token, with no expiry to run out.
    expect(
      openMediaTicket(
        sentUrl.slice("https://gateway.test/media/".length),
        SECRET,
      ),
    ).toEqual({
      accountId: ACCOUNT,
      workspaceId: "ws_a",
      namespace: NS,
      path: "profile.jpeg",
    });
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

  it("refuses both sources rather than picking one", async (): Promise<void> => {
    const { sendImageTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const sendImage = mock(async function (): Promise<void> {});
    const tools = sendImageTool(channelContext(sendImage));

    const sent = execute(tools["send-image"], {
      file_path: "profile.jpeg",
      url: "https://example.com/other.png",
    });

    await expect(sent).rejects.toThrow("takes file_path or url, not both");
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
    accountId: ACCOUNT,
    workspaces: [WORKSPACE],
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
