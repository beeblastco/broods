/**
 * Inbound channel media tests.
 * Cover what reaches the model, what is stored, and what a failed read costs —
 * an attachment nobody can read must still leave the message legible.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Attachment } from "chat";
import type { WorkspaceConfig } from "../src/shared/domain/workspace-config.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const writeS3ObjectMock = mock(
  async (
    _bucket: string,
    _key: string,
    body: string | Uint8Array,
    _options?: { contentType?: string; executable?: boolean },
  ): Promise<number> =>
    typeof body === "string" ? body.length : body.byteLength,
);

mock.module("../src/shared/s3.ts", () => ({
  writeS3Object: writeS3ObjectMock,
  // Full surface so transitive importers keep working (mock.module replaces the module).
  headS3Object: mock(async () => undefined),
  readS3Bytes: mock(async () => new Uint8Array()),
  readS3Text: mock(async () => ""),
  s3ObjectExists: mock(async () => true),
  getS3ObjectUrl: mock(async () => ""),
  listS3Prefix: mock(async () => []),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  isMissingS3Error: () => false,
}));

const { ingestInboundAttachments, readAttachmentBytes, resolveMediaType } =
  await import("../src/harness/channel-media.ts");

const ORIGINAL_ENV = { ...process.env };
const ACCOUNT = "acct_1";
// A one-pixel PNG, so the sniffer has a real signature to read.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.SERVICE_AUTH_SECRET = "service-auth-secret";
  process.env.PUBLIC_BASE_URL = "https://core.example";
  writeS3ObjectMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveMediaType", () => {
  it("trusts the bytes over what the provider claimed", () => {
    // Telegram calls every photo a JPEG whatever was uploaded.
    expect(resolveMediaType(PNG_BYTES, "image/jpeg")).toBe("image/png");
  });

  it("keeps a specific claim over a sniff that only names the container", () => {
    // A .docx really is a zip, and "zip" is the worse of the two answers.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(
      resolveMediaType(
        zip,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("falls back to the claim when nothing can be sniffed", () => {
    expect(resolveMediaType(Buffer.from("id,name\n1,a\n"), "text/csv")).toBe(
      "text/csv",
    );
  });

  it("names an unreadable file rather than guessing", () => {
    expect(resolveMediaType(Buffer.from([0, 1, 2, 3]), undefined)).toBe(
      "application/octet-stream",
    );
  });
});

describe("ingestInboundAttachments", () => {
  it("stores a picture and hands the model a durable link, not the bytes", async () => {
    const parts = await ingestInboundAttachments([imageAttachment()], {
      accountId: ACCOUNT,
      channelName: "telegram",
      eventId: "evt-1",
      workspace: workspace(),
    });

    const image = parts.durable.find((part) => part.type === "image");
    expect(image).toBeDefined();
    if (image?.type !== "image") throw new Error("expected an image part");
    // A sealed media link, never a base64 payload: the conversation is stored
    // as JSON and re-read on every later turn.
    expect(String(image.image)).toStartWith("https://core.example/media/");
    expect(image.mediaType).toBe("image/png");

    expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
    const [, key, body, options] = writeS3ObjectMock.mock.calls[0]!;
    expect(key).toContain(".inbox/");
    expect(key).toEndWith("-photo.png");
    expect(body).toEqual(PNG_BYTES);
    expect(options).toEqual({ contentType: "image/png" });
  });

  it("tells the agent where every attachment landed", async () => {
    const parts = await ingestInboundAttachments([imageAttachment()], {
      accountId: ACCOUNT,
      channelName: "telegram",
      eventId: "evt-1",
      workspace: workspace(),
    });

    const note = noteText(parts);
    expect(note).toContain("Attachments received on telegram");
    expect(note).toContain(".inbox/");
    // Told only that a file exists, models ask the sender to paste it.
    expect(note).toContain("do not ask the sender to paste");
  });

  it("delivers a voice note as a file the agent can open, not as a part the model would refuse", async () => {
    const parts = await ingestInboundAttachments(
      [
        {
          type: "audio",
          name: "voice.aac",
          mimeType: "audio/aac",
          fetchData: async (): Promise<Buffer> => Buffer.from("audio-bytes"),
        },
      ],
      {
        accountId: ACCOUNT,
        channelName: "telegram",
        eventId: "evt-2",
        // Anthropic reads PDFs and pictures; audio would fail the whole turn.
        provider: "anthropic",
        workspace: workspace(),
      },
    );

    expect(
      [...parts.durable, ...parts.transient].filter(
        (part) => part.type !== "text",
      ),
    ).toEqual([]);
    expect(noteText(parts)).toContain("voice.aac");
    expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
  });

  it("sends a voice note natively to a provider that listens to it", async () => {
    const parts = await ingestInboundAttachments(
      [
        {
          type: "audio",
          name: "voice.aac",
          mimeType: "audio/aac",
          fetchData: async (): Promise<Buffer> => Buffer.from("audio-bytes"),
        },
      ],
      {
        accountId: ACCOUNT,
        channelName: "telegram",
        eventId: "evt-3",
        provider: "google",
        workspace: workspace(),
      },
    );

    const file = parts.durable.find((part) => part.type === "file");
    if (file?.type !== "file") throw new Error("expected a file part");
    expect(String(file.data)).toStartWith("https://core.example/media/");
    expect(file.mediaType).toBe("audio/aac");
  });

  it("describes an attachment it could not read instead of dropping it", async () => {
    const parts = await ingestInboundAttachments(
      [
        {
          type: "image",
          name: "photo.png",
          mimeType: "image/png",
          fetchData: async (): Promise<Buffer> => {
            throw new Error("Slack answered 403");
          },
        },
      ],
      {
        accountId: ACCOUNT,
        channelName: "slack",
        eventId: "evt-4",
        workspace: workspace(),
      },
    );

    // Silently dropping it would leave the model answering a message it can
    // only see half of.
    expect(noteText(parts)).toContain("photo.png");
    expect(noteText(parts)).toContain("Slack answered 403");
    expect(writeS3ObjectMock).not.toHaveBeenCalled();
  });

  it("refuses a picture larger than the cap without downloading it", async () => {
    const fetchData = mock(async (): Promise<Buffer> => PNG_BYTES);
    const parts = await ingestInboundAttachments(
      [
        {
          type: "image",
          name: "huge.png",
          mimeType: "image/png",
          size: 64 * 1024 * 1024,
          fetchData: fetchData,
        },
      ],
      {
        accountId: ACCOUNT,
        channelName: "slack",
        eventId: "evt-5",
        workspace: workspace(),
      },
    );

    expect(fetchData).not.toHaveBeenCalled();
    expect(noteText(parts)).toContain("larger than");
  });

  it("hands the current turn the bytes when there is no workspace to store into", async () => {
    const parts = await ingestInboundAttachments([imageAttachment()], {
      accountId: ACCOUNT,
      channelName: "discord",
      eventId: "evt-6",
    });

    // The picture still reaches the model — as bytes, marked transient so
    // nothing persisted or queued ever carries them.
    const image = parts.transient.find((part) => part.type === "image");
    if (image?.type !== "image")
      throw new Error("expected a transient image part");
    expect(image.image).toEqual(PNG_BYTES);
    expect(parts.durable.filter((part) => part.type !== "text")).toEqual([]);
    expect(noteText(parts)).toContain("no workspace is attached");
    expect(writeS3ObjectMock).not.toHaveBeenCalled();
  });

  it("names the attachments it left with the provider rather than pretending they arrived", async () => {
    const parts = await ingestInboundAttachments(
      Array.from({ length: 12 }, () => imageAttachment()),
      {
        accountId: ACCOUNT,
        channelName: "discord",
        eventId: "evt-7",
        workspace: workspace(),
      },
    );

    expect(writeS3ObjectMock).toHaveBeenCalledTimes(10);
    expect(noteText(parts)).toContain("2 further attachment(s)");
  });

  it("does nothing at all when nothing was attached", async () => {
    expect(
      await ingestInboundAttachments([], {
        accountId: ACCOUNT,
        channelName: "telegram",
        eventId: "evt-8",
        workspace: workspace(),
      }),
    ).toEqual({ durable: [], transient: [] });
  });
});

function imageAttachment(): Attachment {
  return {
    type: "image",
    name: "photo.png",
    mimeType: "image/png",
    fetchData: async (): Promise<Buffer> => PNG_BYTES,
  };
}

function noteText(
  parts: Awaited<ReturnType<typeof ingestInboundAttachments>>,
): string {
  return parts.durable
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function workspace(): ResolvedWorkspace {
  return {
    name: "main",
    workspaceId: "ws_1",
    namespace: "fs-0123456789abcdef0123456789abcdef01234567",
    config: {} as WorkspaceConfig,
  };
}

describe("readAttachmentBytes URL guard", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refuses a host that resolves to a private address", async (): Promise<void> => {
    // The URL comes out of the webhook body, so the sender picks the host. A
    // literal here, but a public name pointed at 127.0.0.1 fails the same check.
    await expect(
      readAttachmentBytes({ type: "file", url: "http://127.0.0.1/secret" }),
    ).rejects.toThrow(/private or metadata address/);
  });

  it("refuses a redirect into the metadata endpoint", async (): Promise<void> => {
    // The whole point of following redirects by hand: the first hop is public
    // and passes, and `redirect: "follow"` would have fetched the second.
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: unknown): Promise<Response> => {
      calls.push(String(input));

      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as unknown as typeof fetch;

    await expect(
      readAttachmentBytes({ type: "file", url: "http://93.184.216.34/a.png" }),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(calls).toEqual(["http://93.184.216.34/a.png"]);
  });
});
