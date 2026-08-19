/**
 * send-images and send-files workspace delivery tests.
 * Cover handing workspace files to a channel that only fetches public URLs, the
 * split between a channel that attaches documents and one that cannot, and the
 * rungs send-images drops through when a channel will not show pictures.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecuteFunction, ToolSet } from "ai";
import type { ChannelToolContext } from "../src/harness/tools/channel.tool.ts";
import type { ChannelFile, ChannelImage } from "../src/shared/channels.ts";
import { channelAttachmentBytes } from "../src/shared/channels.ts";
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
  readS3Bytes: mock(async () => new TextEncoder().encode("pdf-bytes")),
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

describe("sendImagesTool", () => {
  it("sends workspace files as durable media links", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sent: ChannelImage[] = [];
    let sentCaption: string | undefined;
    const tools = sendImagesTool(
      channelContext(async function (images, caption): Promise<void> {
        sent = images;
        sentCaption = caption;
      }),
    );

    const result = await execute(tools["send-images"], {
      file_paths: ["profile.jpeg", "charts/q3.png"],
      caption: "here you go",
    });

    expect(s3ObjectExistsMock.mock.calls[0]).toEqual([
      "filesystem-bucket",
      `${NS}/profile.jpeg`,
    ]);
    expect(sentCaption).toBe("[safe] here you go");
    expect(sent.map((image) => image.type)).toEqual(["image", "image"]);
    expect(sent.map((image) => image.mimeType)).toEqual([
      "image/jpeg",
      "image/png",
    ]);
    // The whole set reaches the channel in one call, so the adapter can group it
    // the way its provider wants rather than posting one message per picture.
    expect(sent[0]!.url.startsWith("https://gateway.test/media/")).toBe(true);
    // The link must survive on its own: everything the media route needs to find
    // the file again is sealed into the token, with no expiry to run out.
    expect(
      openMediaTicket(
        sent[0]!.url.slice("https://gateway.test/media/".length),
        SECRET,
      ),
    ).toEqual({
      accountId: ACCOUNT,
      workspaceId: "ws_a",
      namespace: NS,
      path: "profile.jpeg",
    });
    expect(result).toContain("2 image(s) sent");
  });

  it("falls back to documents when the channel cannot show pictures", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sent: ChannelFile[] = [];
    const context = channelContext(async function (): Promise<void> {});
    const tools = sendImagesTool({
      ...context,
      actions: {
        sendText: context.actions.sendText,
        sendTyping: context.actions.sendTyping,
        reactToMessage: context.actions.reactToMessage,
        sendFiles: async function (files): Promise<void> {
          sent = files;
        },
      },
    });

    const result = await execute(tools["send-images"], {
      file_paths: ["profile.jpeg"],
    });

    // Same sealed link, offered as something to download rather than look at.
    expect(sent.map((file) => file.type)).toEqual(["file"]);
    expect(sent[0]!.name).toBe("profile.jpeg");
    expect(result).toContain("1 file(s) sent");
  });

  it("falls back to documents when the channel rejects the batch", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sent: ChannelFile[] = [];
    const context = channelContext(async function (): Promise<void> {
      throw new Error("media group rejected");
    });
    const tools = sendImagesTool({
      ...context,
      actions: {
        ...context.actions,
        sendFiles: async function (files): Promise<void> {
          sent = files;
        },
      },
    });

    const result = await execute(tools["send-images"], {
      file_paths: ["profile.jpeg"],
    });

    // A provider that takes the batch and refuses it must not cost the recipient
    // the picture, so the error is logged and the next route down runs.
    expect(sent.map((file) => file.name)).toEqual(["profile.jpeg"]);
    expect(result).toContain("1 file(s) sent");
  });

  it("falls back to download links when the channel has no document endpoint", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sentText = "";
    // Zalo's shape: it can send a photo but has no document endpoint at all, so
    // a refused photo has only the text link left.
    const context = channelContext(async function (): Promise<void> {
      throw new Error("sendPhoto rejected");
    });
    const tools = sendImagesTool({
      ...context,
      actions: {
        ...context.actions,
        sendText: async function (text: string): Promise<void> {
          sentText = text;
        },
      },
    });

    const result = await execute(tools["send-images"], {
      file_paths: ["profile.jpeg"],
      caption: "xem hình",
    });

    expect(sentText.startsWith("[safe] xem hình\nprofile.jpeg: ")).toBe(true);
    expect(result).toContain("could not attach documents");
  });

  it("reports a missing workspace file instead of sending", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    s3ObjectExistsMock.mockImplementation(async () => false);
    const sendImages = mock(async function (): Promise<void> {});
    const tools = sendImagesTool(channelContext(sendImages));

    const sent = execute(tools["send-images"], { file_paths: ["missing.png"] });

    await expect(sent).rejects.toThrow("Error: file not found: missing.png");
    expect(sendImages).not.toHaveBeenCalled();
  });

  it("refuses both sources rather than picking one", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const sendImages = mock(async function (): Promise<void> {});
    const tools = sendImagesTool(channelContext(sendImages));

    const sent = execute(tools["send-images"], {
      file_paths: ["profile.jpeg"],
      urls: ["https://example.com/other.png"],
    });

    await expect(sent).rejects.toThrow("takes file_paths or urls, not both");
    expect(sendImages).not.toHaveBeenCalled();
  });

  it("requires either workspace files or URLs", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const sendImages = mock(async function (): Promise<void> {});
    const tools = sendImagesTool(channelContext(sendImages));

    const sent = execute(tools["send-images"], { caption: "no image" });

    await expect(sent).rejects.toThrow("send-images needs either file_paths");
    expect(sendImages).not.toHaveBeenCalled();
  });

  it("offers no workspace file path when no workspace is attached", async (): Promise<void> => {
    const { sendImagesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const context = channelContext(mock(async function (): Promise<void> {}));
    const tools = sendImagesTool({ ...context, workspaces: [] });
    const schema = tools["send-images"]!.inputSchema as {
      jsonSchema: { properties: Record<string, unknown> };
    };

    expect(Object.keys(schema.jsonSchema.properties)).toEqual([
      "urls",
      "caption",
    ]);
  });
});

describe("sendFilesTool", () => {
  it("attaches the documents when the channel can send them", async (): Promise<void> => {
    const { sendFilesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sent: ChannelFile[] = [];
    let sentCaption: string | undefined;
    const context = channelContext(async function (): Promise<void> {});
    const tools = sendFilesTool({
      ...context,
      actions: {
        ...context.actions,
        sendFiles: async function (files, caption): Promise<void> {
          sent = files;
          sentCaption = caption;
        },
      },
    });

    const result = await execute(tools["send-files"], {
      file_paths: ["docs/declaration.pdf", "docs/prices.csv"],
      caption: "here you go",
    });

    // The whole batch reaches the channel in one call, so the adapter can spend
    // it the way its provider wants: one album, or one message per file.
    expect(sent.map((file) => file.name)).toEqual([
      "declaration.pdf",
      "prices.csv",
    ]);
    expect(sent.map((file) => file.type)).toEqual(["file", "file"]);
    expect(sent.map((file) => file.mimeType)).toEqual([
      "application/pdf",
      "text/csv",
    ]);
    expect(sent[0]!.url.startsWith("https://gateway.test/media/")).toBe(true);
    expect(sentCaption).toBe("[safe] here you go");
    expect(result).toContain("2 file(s) sent");
  });

  it("posts download links as text when the channel cannot attach", async (): Promise<void> => {
    const { sendFilesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sentText = "";
    const context = channelContext(async function (): Promise<void> {});
    const tools = sendFilesTool({
      ...context,
      actions: {
        ...context.actions,
        sendText: async function (text: string): Promise<void> {
          sentText = text;
        },
      },
    });

    const result = await execute(tools["send-files"], {
      file_paths: ["docs/declaration.pdf"],
      caption: "công bố sản phẩm",
    });

    expect(
      sentText.startsWith("[safe] công bố sản phẩm\ndeclaration.pdf: "),
    ).toBe(true);
    // The fallback link is the same sealed ticket the attachment path hands over.
    const url = sentText.slice(sentText.indexOf("https://"));
    expect(
      openMediaTicket(url.slice("https://gateway.test/media/".length), SECRET),
    ).toEqual({
      accountId: ACCOUNT,
      workspaceId: "ws_a",
      namespace: NS,
      path: "docs/declaration.pdf",
    });
    expect(result).toContain("could not attach documents");
  });

  it("falls back to download links when the upload is rejected", async (): Promise<void> => {
    const { sendFilesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sentText = "";
    const context = channelContext(async function (): Promise<void> {});
    const tools = sendFilesTool({
      ...context,
      actions: {
        ...context.actions,
        sendFiles: async function (): Promise<void> {
          throw new Error("file too large");
        },
        sendText: async function (text: string): Promise<void> {
          sentText = text;
        },
      },
    });

    // Uploading fails on the provider's terms — Discord caps a free guild at
    // 10 MB — and the link needs no upload, so it is worth trying before the
    // recipient gets nothing.
    const result = await execute(tools["send-files"], {
      file_paths: ["docs/declaration.pdf"],
    });

    expect(sentText).toContain("declaration.pdf: https://gateway.test/media/");
    expect(result).toContain("could not attach documents");
  });

  it("carries a reader so an uploading provider can get the bytes", async (): Promise<void> => {
    const { sendFilesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    let sent: ChannelFile[] = [];
    const context = channelContext(async function (): Promise<void> {});
    const tools = sendFilesTool({
      ...context,
      actions: {
        ...context.actions,
        sendFiles: async function (files): Promise<void> {
          sent = files;
        },
      },
    });

    await execute(tools["send-files"], {
      file_paths: ["docs/declaration.pdf"],
    });

    // Slack and Discord ignore the URL and upload bytes, so every workspace
    // attachment carries a reader they can call. It stays unread otherwise.
    expect(typeof sent[0]!.fetchData).toBe("function");
    expect(await channelAttachmentBytes(sent[0]!)).toEqual(
      Buffer.from("pdf-bytes"),
    );
  });

  it("reports a missing workspace file instead of sending", async (): Promise<void> => {
    const { sendFilesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    s3ObjectExistsMock.mockImplementation(async () => false);
    const sendText = mock(async function (): Promise<void> {});
    const context = channelContext(async function (): Promise<void> {});
    const tools = sendFilesTool({
      ...context,
      actions: { ...context.actions, sendText: sendText },
    });

    const sent = execute(tools["send-files"], { file_paths: ["missing.pdf"] });

    await expect(sent).rejects.toThrow("Error: file not found: missing.pdf");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("is not registered when no workspace is attached", async (): Promise<void> => {
    const { sendFilesTool } =
      await import("../src/harness/tools/channel.tool.ts");
    const context = channelContext(async function (): Promise<void> {});

    expect(sendFilesTool({ ...context, workspaces: [] })).toEqual({});
  });
});

function channelContext(
  sendImages: (images: ChannelImage[], caption?: string) => Promise<void>,
): ChannelToolContext {
  return {
    actions: {
      sendImages: sendImages,
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
