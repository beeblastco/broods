import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ImagePart, ModelMessage, UserContent } from "ai";
import type { Attachment } from "chat";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { TLS_CERT, TLS_KEY } from "./helpers/tls.ts";
import type { PinnedFetchTransport } from "../src/shared/http.ts";
import { requestUrl, stubPublicDns } from "./helpers/http.ts";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type { WorkspaceConfig } from "../src/shared/domain/workspace-config.ts";
import type { TranscriptOutcome } from "../src/harness/transcribe.ts";
import {
  openMediaTicket,
  sealMediaTicket,
  type MediaTicket,
} from "../src/shared/media-ticket.ts";
import { unreadableMediaNote } from "../src/shared/media-types.ts";
import type { S3Access, S3ObjectHead } from "../src/shared/s3.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const meterWrites: Array<{
  accountId: string;
  usage: Parameters<Storage["budgets"]["record"]>[1];
  source?: Parameters<Storage["budgets"]["record"]>[2];
}> = [];

const headS3ObjectMock = mock(
  async (_bucket: string, _key: string): Promise<S3ObjectHead | null> => null,
);
const readS3BytesMock = mock(
  async (_bucket: string, _key: string): Promise<Uint8Array> =>
    new Uint8Array(),
);
const writeS3ObjectMock = mock(
  async (
    _bucket: string,
    _key: string,
    body: string | Uint8Array,
    _options?: {
      contentType?: string;
      executable?: boolean;
      access?: S3Access;
    },
  ): Promise<number> =>
    typeof body === "string" ? body.length : body.byteLength,
);

void mock.module("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = async (): Promise<{
      Credentials: {
        AccessKeyId: string;
        SecretAccessKey: string;
        SessionToken: string;
      };
    }> => ({
      Credentials: {
        AccessKeyId: "ASIA_BYO",
        SecretAccessKey: "byo-secret",
        SessionToken: "byo-token",
      },
    });
  },
  AssumeRoleCommand: class {},
}));

await mock.module("../src/shared/s3.ts", () => ({
  writeS3Object: writeS3ObjectMock,
  headS3Object: headS3ObjectMock,
  // mock.module replaces the whole module, so transitive importers need the full surface.
  readS3Bytes: readS3BytesMock,
  readS3Text: mock(async () => ""),
  s3ObjectExists: mock(async () => true),
  getS3ObjectUrl: mock(async () => ""),
  putS3ObjectUrl: mock(async () => ""),
  listS3Prefix: mock(async () => []),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  isMissingS3Error: () => false,
}));

const transcribeAudioMock = mock(async (): Promise<TranscriptOutcome> => ({
  status: "transcribed",
  text: "check the deploy status",
}));

// The real retry budget and advice: a factory naming only `transcribeAudio` would lose them.
const { TRANSCRIPTION_RETRIES, transcriptAdvice } =
  await import("../src/harness/transcribe.ts");

await mock.module("../src/harness/transcribe.ts", () => ({
  TRANSCRIPTION_RETRIES: TRANSCRIPTION_RETRIES,
  transcribeAudio: transcribeAudioMock,
  transcriptAdvice: transcriptAdvice,
}));

const {
  acceptsNativeMedia,
  ingestInboundAttachments,
  readAttachmentBytes,
  rehydrateStoredMedia,
  resolveMediaType,
  sealConversationMedia,
} = await import("../src/harness/channel-media.ts");

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ACCOUNT = "acct_1";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.MEDIA_TICKET_SECRET = "media-ticket-secret";
  delete process.env.MEDIA_TICKET_TTL_SECONDS;
  process.env.PUBLIC_BASE_URL = "https://core.example";
  headS3ObjectMock.mockReset();
  readS3BytesMock.mockReset();
  writeS3ObjectMock.mockClear();
  transcribeAudioMock.mockClear();
  meterWrites.length = 0;
  setStorageForTests({
    budgets: {
      record: async function (
        accountId: string,
        usage: Parameters<Storage["budgets"]["record"]>[1],
        source?: Parameters<Storage["budgets"]["record"]>[2],
      ): Promise<void> {
        meterWrites.push({
          accountId: accountId,
          usage: usage,
          ...(source ? { source: source } : {}),
        });
      },
    },
  } as never);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  resetStorageForTests();
});

describe("resolveMediaType", () => {
  it("trusts the bytes over what the provider claimed", () => {
    // Telegram calls every photo a JPEG whatever was uploaded.
    expect(resolveMediaType(PNG_BYTES, "image/jpeg")).toBe("image/png");
  });

  it("keeps a specific claim over a sniff that only names the container", () => {
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
      agentId: "agent_1",
      channelName: "telegram",
      eventId: "evt-1",
      workspace: workspace(),
    });

    const image = parts.stored.find((part) => part.type === "image");
    expect(image).toBeDefined();
    if (image?.type !== "image") throw new Error("expected an image part");
    // Never base64: the conversation is stored as JSON and re-read on every later turn.
    if (typeof image.image !== "string") {
      throw new Error("expected a string image URL");
    }
    expect(image.image).toStartWith("https://core.example/v1/media/");
    expect(image.mediaType).toBe("image/png");

    // One copy in the agent's mount, one in the attachment store a workspace clean-up can't reach.
    expect(writeS3ObjectMock).toHaveBeenCalledTimes(2);
    const [, workspaceKey, workspaceBody, workspaceOptions] =
      writeS3ObjectMock.mock.calls[0]!;
    const [, storeKey] = writeS3ObjectMock.mock.calls[1]!;
    expect(workspaceKey).toStartWith(`${workspace().namespace}/media/`);
    expect(workspaceKey).toEndWith("-photo.png");
    expect(workspaceBody).toEqual(PNG_BYTES);
    expect(workspaceOptions).toEqual({ contentType: "image/png" });
    expect(storeKey).toStartWith(`attachments/${ACCOUNT}/media/`);
    expect(storeKey).toEndWith("-photo.png");
    expect(meterWrites).toEqual([
      {
        accountId: ACCOUNT,
        usage: { ingressGb: PNG_BYTES.byteLength / 1e9 },
        source: { agentId: "agent_1" },
      },
    ]);
  });

  it("writes a bring-your-own workspace copy on the assumed role, the store copy on core's", async () => {
    setStorageForTests({
      budgets: { record: async (): Promise<void> => undefined },
      workspaceConfigs: {
        storageExternalId: async (accountId: string): Promise<string> =>
          `broods-ext-${accountId}`,
      },
    } as never);
    await ingestInboundAttachments([imageAttachment()], {
      accountId: ACCOUNT,
      channelName: "telegram",
      eventId: "evt-1",
      workspace: {
        ...workspace(),
        config: {
          storage: {
            provider: "s3",
            bucket: "acme",
            prefix: "agents/",
            region: "eu-west-1",
            auth: { type: "assumeRole", roleArn: "arn:aws:iam::2:role/byo" },
            owner: { accountId: ACCOUNT, workspaceId: "ws_byo" },
          },
        },
      },
    });

    expect(writeS3ObjectMock).toHaveBeenCalledTimes(2);
    const [workspaceBucket, workspaceKey, , workspaceOptions] =
      writeS3ObjectMock.mock.calls[0]!;
    const [storeBucket, , , storeOptions] = writeS3ObjectMock.mock.calls[1]!;
    expect(workspaceBucket).toBe("acme");
    expect(workspaceKey).toStartWith("agents/media/");
    expect(workspaceOptions?.access?.credentials).toEqual({
      accessKeyId: "ASIA_BYO",
      secretAccessKey: "byo-secret",
      sessionToken: "byo-token",
    });
    expect(workspaceOptions?.access?.region).toBe("eu-west-1");
    expect(storeBucket).toBe("filesystem-bucket");
    expect(storeOptions?.access).toBeUndefined();
  });

  it("seals the link against the attachment store, not the workspace", async () => {
    const parts = await ingestInboundAttachments([imageAttachment()], {
      accountId: ACCOUNT,
      agentId: "agent_1",
      channelName: "telegram",
      eventId: "evt-1",
      workspace: workspace(),
    });

    const image = parts.stored.find((part) => part.type === "image");
    if (image?.type !== "image") throw new Error("expected an image part");
    if (typeof image.image !== "string") {
      throw new Error("expected a string image URL");
    }
    const token = image.image.slice("https://core.example/v1/media/".length);
    const ticket = openMediaTicket(token, ["media-ticket-secret"]);
    expect(ticket).not.toBeNull();
    expect(ticket).not.toHaveProperty("workspaceId");
    expect(ticket?.path).toStartWith("media/");
    expect(ticket?.path).toEndWith("-photo.png");
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
    expect(note).toContain("media/");
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
        agentConfig: modelConfig("anthropic"),
        workspace: workspace(),
      },
    );

    expect(
      [...parts.stored, ...parts.turn].filter((part) => part.type !== "text"),
    ).toEqual([]);
    expect(noteText(parts)).toContain("voice.aac");
    expect(writeS3ObjectMock).toHaveBeenCalledTimes(2);
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
        agentConfig: modelConfig("google"),
        workspace: workspace(),
      },
    );

    const file = parts.stored.find((part) => part.type === "file");
    if (file?.type !== "file") throw new Error("expected a file part");
    if (typeof file.data !== "string") {
      throw new Error("expected a string file URL");
    }
    expect(file.data).toStartWith("https://core.example/v1/media/");
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

    // The row keeps no bytes: this attachment names no file the channel could serve again.
    const image = parts.turn.find((part) => part.type === "image");
    if (image?.type !== "image") throw new Error("expected an image part");
    expect(image.image).toEqual(PNG_BYTES);
    expect(parts.stored.filter((part) => part.type !== "text")).toEqual([]);
    expect(noteText(parts)).toContain("no workspace is attached");
    expect(writeS3ObjectMock).not.toHaveBeenCalled();
  });

  it("says an attachment reached nobody rather than calling it available for the turn", async () => {
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
        channelName: "zalo",
        eventId: "evt-9",
        // No audio on Anthropic, and no workspace to store the file in instead.
        agentConfig: modelConfig("anthropic"),
      },
    );

    expect(
      [...parts.stored, ...parts.turn].filter((part) => part.type !== "text"),
    ).toEqual([]);
    expect(noteText(parts)).toContain("could not be shown");
    expect(noteText(parts)).not.toContain("is available for this message only");
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

    expect(writeS3ObjectMock).toHaveBeenCalledTimes(20);
    expect(meterWrites).toEqual([
      {
        accountId: ACCOUNT,
        usage: { ingressGb: (10 * PNG_BYTES.byteLength) / 1e9 },
      },
    ]);
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
    ).toEqual({ stored: [], turn: [] });
  });
});

describe("acceptsNativeMedia", () => {
  it("refuses a subtype the provider does not read", () => {
    expect(acceptsNativeMedia("openai", "audio/ogg")).toBe(false);
    expect(acceptsNativeMedia("openai", "application/pdf")).toBe(true);
  });

  it("reads pictures on every provider, listed or not", () => {
    expect(acceptsNativeMedia("anthropic", "image/png")).toBe(true);
    expect(acceptsNativeMedia(undefined, "image/png")).toBe(true);
  });

  it("honours a type/* entry for the providers that take a whole family", () => {
    expect(acceptsNativeMedia("google", "audio/ogg")).toBe(true);
    expect(acceptsNativeMedia("google", "video/mp4")).toBe(true);
  });
});

describe("inbound audio", () => {
  async function ingestVoiceNote(
    provider: AccountModelProviderName,
  ): Promise<Awaited<ReturnType<typeof ingestInboundAttachments>>> {
    const voiceNote: Attachment = {
      type: "audio",
      name: "voice.ogg",
      mimeType: "audio/ogg",
      fetchData: async (): Promise<Buffer> => Buffer.from("audio-bytes"),
    };

    return await ingestInboundAttachments([voiceNote], {
      accountId: ACCOUNT,
      channelName: "telegram",
      eventId: "evt-audio",
      agentConfig: modelConfig(provider),
      workspace: workspace(),
    });
  }

  it("puts the words in the note when the model cannot hear the file", async () => {
    const parts = await ingestVoiceNote("openai");

    expect(transcribeAudioMock).toHaveBeenCalledTimes(1);
    expect(noteText(parts)).toContain("Transcript: check the deploy status");
    expect(noteText(parts)).toContain("saved to media/");
    expect(
      [...parts.stored, ...parts.turn].filter((part) => part.type !== "text"),
    ).toEqual([]);
  });

  it("does not transcribe audio the provider listens to itself", async () => {
    await ingestVoiceNote("google");

    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("sends the agent back to the file when the attempt is worth repeating", async () => {
    transcribeAudioMock.mockResolvedValueOnce({
      status: "failed",
      reason: "provider answered 503",
      recovery: "retry",
    });

    expect(await ingestVoiceNote("openai").then(noteText)).toContain(
      "Read the file to try again before you answer",
    );
  });

  it("hands a refused recording to the agent with the file", async () => {
    transcribeAudioMock.mockResolvedValueOnce({
      status: "failed",
      reason:
        "Invalid file format. Supported formats: ['mp3', 'mp4', 'm4a', 'wav', 'webm']",
      recovery: "unsupported",
    });
    const note = await ingestVoiceNote("openai").then(noteText);

    expect(note).toContain("Supported formats");
    expect(note).toContain("It is still yours to work with at media/");
    expect(note).not.toContain("Read the file to try again");
  });

  it("tells the agent not to retry what cannot work", async () => {
    transcribeAudioMock.mockResolvedValueOnce({
      status: "failed",
      reason: "anthropic has no transcription model",
      recovery: "unavailable",
    });

    expect(await ingestVoiceNote("anthropic").then(noteText)).toContain(
      "Reading it again will not help",
    );
  });
});

describe("rehydrateStoredMedia", () => {
  it("keeps a reference to the channel's own copy when nothing stored the bytes", async () => {
    const parts = await ingestInboundAttachments(
      [{ ...imageAttachment(), fetchMetadata: { fileId: "file-42" } }],
      {
        accountId: ACCOUNT,
        channelName: "telegram",
        eventId: "evt-10",
      },
    );

    const turn = parts.turn.find((part) => part.type === "image");
    if (turn?.type !== "image") throw new Error("expected an image part");
    expect(turn.image).toEqual(PNG_BYTES);

    const stored = parts.stored.find((part) => part.type === "image");
    if (stored?.type !== "image") throw new Error("expected an image part");
    expect(stored.image).toBe(
      "broods-media://telegram/photo.png?fileId=file-42&mediaType=image%2Fpng&type=image",
    );
    expect(noteText(parts)).toContain("read from telegram");
  });

  it("keeps one copy's worth of bytes for a picture that arrives again", async () => {
    const large = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    let stored: ModelMessage | undefined;
    for (let i = 0; i < 7; i += 1) {
      const parts = await ingestInboundAttachments(
        [
          {
            ...imageAttachment(),
            fetchData: async (): Promise<Buffer> => large,
            fetchMetadata: { fileId: "file-again" },
          },
        ],
        { accountId: ACCOUNT, channelName: "telegram", eventId: `evt-${i}` },
      );
      const image = parts.stored.find((part) => part.type === "image");
      if (image?.type !== "image") throw new Error("expected an image part");
      stored = { role: "user", content: [image] };
    }
    if (!stored) throw new Error("expected a stored message");
    const fetchMock = telegramFetch();

    const messages = await rehydrateStoredMedia(
      [stored],
      telegramConfig(),
      ACCOUNT,
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected message parts");
    const image = content.find((part) => part.type === "image");
    if (image?.type !== "image") throw new Error("expected an image part");
    expect(image.image).toEqual(large);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the bytes back through the channel that delivered them", async () => {
    const fetchMock = telegramFetch();
    // The configured apiUrl is the tenant's host, so the download is pinned to where it resolves.
    const restoreDns = stubPublicDns();
    const messages = await rehydrateStoredMedia(
      [storedMessage("file-77")],
      telegramConfig(),
      ACCOUNT,
    ).finally(restoreDns);

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected message parts");
    const image = content.find((part) => part.type === "image");
    if (image?.type !== "image") throw new Error("expected an image part");
    expect(image.image).toEqual(PNG_BYTES);
    // Only the bot token makes the file readable, so the download goes through getFile.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("getFile")),
    ).toBe(true);
  });

  // The part replays on every later turn, so a provider switch would break messages that worked.
  it("demotes a stored part the model running now cannot read", async () => {
    const messages = await rehydrateStoredMedia(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "listen to this" },
            {
              type: "file",
              mediaType: "audio/ogg",
              filename: "voice.ogg",
              data: "https://core.example/v1/media/sealed-token",
            },
          ],
        },
      ],
      modelConfig("openai"),
      ACCOUNT,
    );

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "listen to this" },
      {
        type: "text",
        text: unreadableMediaNote("voice.ogg", "audio/ogg"),
      },
    ]);
  });

  // Tool results and subagent output are file parts too; re-gating would rewrite them every turn.
  it("leaves a file part it did not store alone", async () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "application/octet-stream",
            data: {
              type: "reference",
              reference: { fileId: "file_abc" },
            },
          } as Exclude<UserContent, string>[number],
        ],
      },
    ];

    expect(
      await rehydrateStoredMedia(messages, modelConfig("openai"), ACCOUNT),
    ).toBe(messages);
  });

  it("says a file the channel dropped is gone instead of failing the turn", async () => {
    telegramFetch({ ok: false });
    const messages = await rehydrateStoredMedia(
      [storedMessage("file-gone")],
      telegramConfig(),
      ACCOUNT,
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected message parts");
    expect(content).toEqual([
      {
        type: "text",
        text: "[photo.png is no longer available from telegram]",
      },
    ]);
  });

  // The provider fetches the link itself: a deleted file would 404 and fail every later turn.
  it("says a workspace file that is gone is gone instead of failing the turn", async (): Promise<void> => {
    setStorageForTests(storageWithWorkspace());

    const messages = await rehydrateStoredMedia(
      [sealedImageMessage(workspaceTicket())],
      modelConfig("openai"),
      ACCOUNT,
    );

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "[0-image-1.jpeg is no longer available]" },
    ]);
  });

  it("says an expired link is gone instead of failing the turn", async (): Promise<void> => {
    setStorageForTests(storageWithWorkspace());
    const sealedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const token = sealMediaTicket(
      workspaceTicket(),
      "media-ticket-secret",
      sealedAt,
    );

    const messages = await rehydrateStoredMedia(
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: `https://core.example/v1/media/${token}`,
              mediaType: "image/jpeg",
            },
          ],
        },
      ],
      modelConfig("openai"),
      ACCOUNT,
    );

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "[a linked file is no longer available]" },
    ]);
  });

  // The provider refetches a prompt link on every model step, so the turn reads it once.
  it("hands the model a sealed link's bytes, read once per link", async (): Promise<void> => {
    setStorageForTests(storageWithWorkspace());
    headS3ObjectMock.mockImplementation(async (): Promise<S3ObjectHead> => ({
      contentLength: 3,
    }));
    readS3BytesMock.mockImplementation(
      async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]),
    );
    const stored = [
      sealedImageMessage({
        ...workspaceTicket(),
        path: "media/ef56/0-image-1.jpeg",
      }),
      sealedImageMessage({
        accountId: ACCOUNT,
        path: "media/cd34/0-image-1.jpeg",
      }),
    ];

    const first = await rehydrateStoredMedia(
      stored,
      modelConfig("openai"),
      ACCOUNT,
    );
    const replay = await rehydrateStoredMedia(
      stored,
      modelConfig("openai"),
      ACCOUNT,
    );

    const bytes = Buffer.from([1, 2, 3]);
    const image: ImagePart = {
      type: "image",
      image: bytes,
      mediaType: "image/jpeg",
    };
    expect(first).toEqual([
      { role: "user", content: [image] },
      { role: "user", content: [image] },
    ]);
    expect(replay).toEqual(first);
    // The replay comes from the media cache; managed-bucket bytes are metered as egress.
    expect(readS3BytesMock).toHaveBeenCalledTimes(2);
    const egress = { accountId: ACCOUNT, usage: { egressGb: 3 / 1e9 } };
    // The two links are read side by side, so in either order.
    expect(meterWrites).toHaveLength(2);
    expect(meterWrites).toEqual(
      expect.arrayContaining([
        { ...egress, source: { workspaceId: "ws_1" } },
        egress,
      ]),
    );
  });

  // The read runs on core's credentials and meters the ticket's account: a foreign one stays shut.
  it("never opens a sealed link that belongs to another account or was forged", async (): Promise<void> => {
    setStorageForTests(storageWithWorkspace());
    headS3ObjectMock.mockImplementation(async (): Promise<S3ObjectHead> => ({
      contentLength: 3,
    }));
    readS3BytesMock.mockImplementation(
      async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3]),
    );
    const stored = [
      sealedImageMessage({
        accountId: "acct_other",
        path: "media/ff00/0-image-1.jpeg",
      }),
    ];

    expect(
      await rehydrateStoredMedia(stored, modelConfig("openai"), ACCOUNT),
    ).toEqual(stored);
    expect(
      await rehydrateStoredMedia(stored, modelConfig("openai"), undefined),
    ).toEqual(stored);
    // A foreign-key link is left for another deployment's host; on this core's host it is gone.
    const foreignKey = sealMediaTicket(
      { accountId: ACCOUNT, path: "media/ff01/0-image-1.jpeg" },
      "not-the-media-ticket-secret",
    );
    const elsewhere: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: `https://other.example/v1/media/${foreignKey}`,
            mediaType: "image/jpeg",
          },
        ],
      },
    ];
    expect(
      await rehydrateStoredMedia(elsewhere, modelConfig("openai"), ACCOUNT),
    ).toEqual(elsewhere);
    const forged: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: `https://core.example/v1/media/${foreignKey}`,
            mediaType: "image/jpeg",
          },
        ],
      },
    ];
    expect(
      (await rehydrateStoredMedia(forged, modelConfig("openai"), ACCOUNT))[0]
        ?.content,
    ).toEqual([
      { type: "text", text: "[a linked file is no longer available]" },
    ]);
    expect(headS3ObjectMock).not.toHaveBeenCalled();
    expect(readS3BytesMock).not.toHaveBeenCalled();
    expect(meterWrites).toEqual([]);
  });

  // Every inlined file rides each model request, so a turn inlines a bounded amount.
  it("leaves big files and links past the turn's byte budget for the provider", async (): Promise<void> => {
    setStorageForTests(storageWithWorkspace());
    const sizeOf = (key: string): number =>
      (key.includes("big") ? 7 : 5) * 1024 * 1024;
    headS3ObjectMock.mockImplementation(
      async (_bucket: string, key: string): Promise<S3ObjectHead> => ({
        contentLength: sizeOf(key),
      }),
    );
    readS3BytesMock.mockImplementation(
      async (_bucket: string, key: string): Promise<Uint8Array> =>
        new Uint8Array(sizeOf(key)),
    );
    const stored = [
      sealedImageMessage({ accountId: ACCOUNT, path: "media/b0/big.jpeg" }),
      ...[1, 2, 3, 4, 5].map((index) =>
        sealedImageMessage({
          accountId: ACCOUNT,
          path: `media/b${index}/a.jpeg`,
        }),
      ),
    ];

    const messages = await rehydrateStoredMedia(
      stored,
      modelConfig("openai"),
      ACCOUNT,
    );

    const parts = messages.flatMap((message): unknown[] =>
      Array.isArray(message.content) ? message.content : [],
    );
    const inlined = parts.filter(
      (part): boolean =>
        typeof part === "object" &&
        part !== null &&
        "image" in part &&
        Buffer.isBuffer(part.image),
    );
    // The 7 MB file is over the cap; four 5 MB files fill the 20 MB budget.
    expect(inlined).toHaveLength(4);
    expect(readS3BytesMock).toHaveBeenCalledTimes(4);
  });

  it("leaves a conversation with no references untouched", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ];

    expect(
      await rehydrateStoredMedia(messages, telegramConfig(), ACCOUNT),
    ).toBe(messages);
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
  return parts.stored
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

function workspaceTicket(): MediaTicket {
  const { workspaceId, namespace } = workspace();

  return {
    accountId: ACCOUNT,
    workspaceId: workspaceId,
    namespace: namespace,
    path: "media/ab12/0-image-1.jpeg",
  };
}

// Real loopback servers: public names map to 127.0.0.1, the only address exempt from the
// denylist, so sockets, redirects and TLS are production's. Guard: isolate-pinned-fetch.test.ts.
describe("sealConversationMedia", () => {
  const base64 = PNG_BYTES.toString("base64");
  const conversation: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what does it say?" },
        { type: "image", image: base64, mediaType: "image/png" },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Screenshot taken." },
              { type: "image-data", data: base64, mediaType: "image/png" },
            ],
          },
        },
      ],
    },
  ];

  it("stores a picture once and replays it on later turns", async (): Promise<void> => {
    const sealed = await sealConversationMedia(conversation, ACCOUNT);

    expect(JSON.stringify(sealed)).not.toContain(base64);
    // The same screenshot twice is one object, keyed by its hash.
    expect(writeS3ObjectMock).toHaveBeenCalledTimes(2);
    const keys = writeS3ObjectMock.mock.calls.map(([, key]) => key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^attachments\/acct_1\/media\/[0-9a-f]{32}\.png$/);

    const replay = await rehydrateStoredMedia(
      sealed,
      modelConfig("custom"),
      ACCOUNT,
    );

    expect(replay).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what does it say?" },
          { type: "image", image: PNG_BYTES, mediaType: "image/png" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Screenshot taken." },
                {
                  type: "file",
                  mediaType: "image/png",
                  data: { type: "data", data: PNG_BYTES },
                },
              ],
            },
          },
        ],
      },
    ]);
  });

  it("replays only the newest pictures of a long conversation", async (): Promise<void> => {
    const sealed = await sealConversationMedia(conversation, ACCOUNT);
    const long = Array.from(
      { length: 11 },
      (): ModelMessage[] => sealed,
    ).flat();

    const replay = JSON.stringify(
      await rehydrateStoredMedia(long, modelConfig("custom"), ACCOUNT),
    );

    // 22 pictures: a batch of the ten oldest become a line, the rest are bytes.
    expect(replay.split("[an earlier image is not shown here]")).toHaveLength(
      11,
    );
    expect(replay).not.toContain("/v1/media/");
  });

  it("spends the replay budget on the newest pictures", async (): Promise<void> => {
    // Just over 4 MB each: the 20 MB budget holds four of the five.
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024)]);
    const shot = (id: string): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "screenshot",
          output: {
            type: "content",
            value: [
              {
                type: "image-data",
                data: big.toString("base64"),
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    });
    const sealed = await sealConversationMedia(
      ["c1", "c2", "c3", "c4", "c5"].map(shot),
      ACCOUNT,
    );

    const replay = await rehydrateStoredMedia(
      sealed,
      modelConfig("custom"),
      ACCOUNT,
    );

    expect(JSON.stringify(replay[0])).toContain(
      "[an earlier image is not shown here]",
    );
    expect(JSON.stringify(replay.slice(1))).not.toContain(
      "[an earlier image is not shown here]",
    );
  });

  // Bedrock refuses a URL inside a tool result before sending the request.
  it("never leaves a tool result's link for the provider", async (): Promise<void> => {
    const sealed = await sealConversationMedia(conversation, ACCOUNT);

    const replay = await rehydrateStoredMedia(
      sealed.slice(1),
      modelConfig("custom"),
      "acct_2",
    );

    expect(JSON.stringify(replay)).not.toContain("/v1/media/");
    expect(JSON.stringify(replay)).toContain(
      "[an earlier image is not shown here]",
    );
  });

  it("leaves a picture it could not store as it was", async (): Promise<void> => {
    writeS3ObjectMock.mockImplementationOnce(async (): Promise<never> => {
      throw new Error("bucket down");
    });

    const sealed = await sealConversationMedia(
      conversation.slice(0, 1),
      ACCOUNT,
    );

    expect(sealed).toEqual(conversation.slice(0, 1));
  });
});

describe("readAttachmentBytes URL guard", () => {
  it("refuses a host that resolves to a private address", async (): Promise<void> => {
    // The URL comes from the webhook body, so the sender picks the host.
    expect(
      readAttachmentBytes({ type: "file", url: "http://127.0.0.1/secret" }),
    ).rejects.toThrow(/private or metadata address/);
  });

  it("carries binary bytes intact over a real socket, resolving the name once", async (): Promise<void> => {
    const payload = Buffer.from(
      Array.from({ length: 4096 }, (_, index) => index % 256),
    );
    const hostHeaders: string[] = [];
    const server = createHttpServer((request, response) => {
      hostHeaders.push(String(request.headers.host));
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(payload);
    });
    const lookups: string[] = [];

    await withServer(server, async (port): Promise<void> => {
      const bytes = await readAttachmentBytes(
        { type: "file", url: `http://public.test:${port}/blob.bin` },
        loopbackTransport({ "public.test": "127.0.0.1" }, lookups),
      );

      expect(bytes.equals(payload)).toBe(true);
      // One lookup and the original Host: no re-resolve after validation, the DNS-rebind window.
      expect(lookups).toEqual(["public.test"]);
      expect(hostHeaders).toEqual([`public.test:${port}`]);
    });
  });

  it("speaks TLS to the pinned address under the original name", async (): Promise<void> => {
    // Verifying `public.test` on a pinned IP needs the hostname as the SNI servername.
    const server = createHttpsServer(
      { cert: TLS_CERT, key: TLS_KEY },
      (_request, response) => {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(PNG_BYTES);
      },
    );

    await withServer(server, async (port): Promise<void> => {
      const bytes = await readAttachmentBytes(
        { type: "file", url: `https://public.test:${port}/photo.png` },
        {
          ...loopbackTransport({ "public.test": "127.0.0.1" }),
          ca: TLS_CERT,
        },
      );

      expect(bytes.equals(PNG_BYTES)).toBe(true);
    });
  });

  it("follows a redirect by re-validating and re-pinning the next host", async (): Promise<void> => {
    const finalServer = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("moved-bytes");
    });
    const lookups: string[] = [];

    await withServer(finalServer, async (finalPort): Promise<void> => {
      const firstServer = createHttpServer((_request, response) => {
        response.writeHead(302, {
          location: `http://cdn.test:${finalPort}/blob.bin`,
        });
        response.end();
      });
      await withServer(firstServer, async (firstPort): Promise<void> => {
        const bytes = await readAttachmentBytes(
          { type: "file", url: `http://public.test:${firstPort}/blob.bin` },
          loopbackTransport(
            { "public.test": "127.0.0.1", "cdn.test": "127.0.0.1" },
            lookups,
          ),
        );

        expect(bytes.toString()).toBe("moved-bytes");
        expect(lookups).toEqual(["public.test", "cdn.test"]);
      });
    });
  });

  it("refuses a redirect into the metadata endpoint", async (): Promise<void> => {
    // Only the loopback is exempt, so the second hop fails on the production denylist.
    const server = createHttpServer((_request, response) => {
      response.writeHead(302, {
        location: "http://metadata.test/latest/meta-data/",
      });
      response.end();
    });

    await withServer(server, async (port): Promise<void> => {
      expect(
        readAttachmentBytes(
          { type: "file", url: `http://public.test:${port}/a.png` },
          loopbackTransport({
            "public.test": "127.0.0.1",
            "metadata.test": "169.254.169.254",
          }),
        ),
      ).rejects.toThrow(/metadata\.test/);
    });
  });

  it("reports a non-2xx answer instead of storing an error page", async (): Promise<void> => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("gone");
    });

    await withServer(server, async (port): Promise<void> => {
      expect(
        readAttachmentBytes(
          { type: "file", url: `http://public.test:${port}/a.png` },
          loopbackTransport({ "public.test": "127.0.0.1" }),
        ),
      ).rejects.toThrow(/provider answered 404/);
    });
  });

  it("refuses a Content-Length past the cap before reading the body", async (): Promise<void> => {
    const server = createHttpServer((_request, response) => {
      response.on("error", () => {});
      response.writeHead(200, {
        "content-length": String(26 * 1024 * 1024),
        "content-type": "application/octet-stream",
      });
      response.write("start");
    });

    await withServer(server, async (port): Promise<void> => {
      expect(
        readAttachmentBytes(
          { type: "file", url: `http://public.test:${port}/big.bin` },
          loopbackTransport({ "public.test": "127.0.0.1" }),
        ),
      ).rejects.toThrow(/exceeded 25MB/);
    });
  });

  it("stops reading a body that outgrows the cap instead of buffering it whole", async (): Promise<void> => {
    // Chunked, so only the read can stop it, not a header check. The server offers at most
    // 30 MB, so a test failing open still terminates.
    const chunk = Buffer.alloc(1024 * 1024);
    const server = createHttpServer((_request, response) => {
      response.on("error", () => {});
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const push = (): void => {
        if (sent >= 30 || response.destroyed) {
          response.end();

          return;
        }
        sent += 1;
        if (response.write(chunk)) {
          setImmediate(push);
        } else {
          response.once("drain", push);
        }
      };
      push();
    });

    await withServer(server, async (port): Promise<void> => {
      expect(
        readAttachmentBytes(
          { type: "file", url: `http://public.test:${port}/endless.bin` },
          loopbackTransport({ "public.test": "127.0.0.1" }),
        ),
      ).rejects.toThrow(/exceeded 25MB/);
    });
  });
});

function loopbackTransport(
  hosts: Record<string, string>,
  lookups?: string[],
): PinnedFetchTransport {
  return {
    allowAddresses: ["127.0.0.1"],
    lookup: async (
      hostname: string,
    ): Promise<{ address: string; family: number }[]> => {
      lookups?.push(hostname);
      const address = hosts[hostname];
      if (!address) {
        throw new Error(`no test DNS entry for ${hostname}`);
      }

      return [{ address: address, family: 4 }];
    },
  };
}

function sealedImageMessage(ticket: MediaTicket): ModelMessage {
  const token = sealMediaTicket(ticket, "media-ticket-secret");

  return {
    role: "user",
    content: [
      {
        type: "image",
        image: `https://core.example/v1/media/${token}`,
        mediaType: "image/jpeg",
      },
    ],
  };
}

function storageWithWorkspace(): Storage {
  return {
    budgets: {
      record: async function (
        accountId: string,
        usage: Parameters<Storage["budgets"]["record"]>[1],
        source?: Parameters<Storage["budgets"]["record"]>[2],
      ): Promise<void> {
        meterWrites.push({
          accountId: accountId,
          usage: usage,
          ...(source ? { source: source } : {}),
        });
      },
    },
    workspaceConfigs: {
      getById: async (): Promise<{
        config: { storage: { provider: string } };
      }> => ({ config: { storage: { provider: "s3" } } }),
    },
  } as never;
}

function storedMessage(fileId: string): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "image",
        image: `broods-media://telegram/photo.png?fileId=${fileId}&mediaType=image%2Fpng&type=image`,
        mediaType: "image/png",
      },
    ],
  };
}

function modelConfig(provider: AccountModelProviderName): AgentConfig {
  return { model: { provider: provider, modelId: "test-model" } };
}

function telegramConfig(): AgentConfig {
  return {
    channels: {
      telegram: {
        botToken: "bot-token",
        webhookSecret: "hook-secret",
        apiUrl: "https://telegram.test",
      },
    },
  };
}

function telegramFetch(
  options: { ok?: boolean } = {},
): ReturnType<typeof mock> {
  const fetchMock = mock(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (!(options.ok ?? true)) {
      return new Response("gone", { status: 404 });
    }
    if (url.includes("getFile")) {
      return Response.json({
        ok: true,
        result: { file_id: "f", file_path: "photos/photo.png" },
      });
    }

    return new Response(PNG_BYTES);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  return fetchMock;
}

async function withServer(
  server: Server,
  run: (port: number) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("test server has no port");
  }
  try {
    await run(address.port);
  } finally {
    server.close();
  }
}
