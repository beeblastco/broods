/**
 * Inbound channel media tests.
 * Cover what reaches the model, what is stored, and what a failed read costs —
 * an attachment nobody can read must still leave the message legible.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ModelMessage } from "ai";
import type { Attachment } from "chat";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import type { PinnedFetchTransport } from "../src/shared/http.ts";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type { WorkspaceConfig } from "../src/shared/domain/workspace-config.ts";
import type { TranscriptOutcome } from "../src/harness/transcribe.ts";
import { unreadableMediaNote } from "../src/shared/media-types.ts";
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

// Transcription is one API call behind a provider's credentials; what the media
// path owes it is the decision to call at all and what it does with the answer.
const transcribeAudioMock = mock(async (): Promise<TranscriptOutcome> => ({
  status: "transcribed",
  text: "check the deploy status",
}));

mock.module("../src/harness/transcribe.ts", () => ({
  transcribeAudio: transcribeAudioMock,
}));

const {
  acceptsNativeMedia,
  ingestInboundAttachments,
  readAttachmentBytes,
  rehydrateStoredMedia,
  resolveMediaType,
} = await import("../src/harness/channel-media.ts");

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ACCOUNT = "acct_1";
// A one-pixel PNG, so the sniffer has a real signature to read.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// A self-signed pair for `public.test`, minted for a hundred years so the TLS
// test never starts flaking on expiry.
const TLS_CERT = readFileSync(
  new URL("./helpers/fixtures/attachment-tls-cert.pem", import.meta.url),
  "utf8",
);
const TLS_KEY = readFileSync(
  new URL("./helpers/fixtures/attachment-tls-key.pem", import.meta.url),
  "utf8",
);

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.SERVICE_AUTH_SECRET = "service-auth-secret";
  process.env.PUBLIC_BASE_URL = "https://core.example";
  writeS3ObjectMock.mockClear();
  transcribeAudioMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
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

    const image = parts.stored.find((part) => part.type === "image");
    expect(image).toBeDefined();
    if (image?.type !== "image") throw new Error("expected an image part");
    // A sealed media link, never a base64 payload: the conversation is stored
    // as JSON and re-read on every later turn.
    expect(String(image.image)).toStartWith("https://core.example/media/");
    expect(image.mediaType).toBe("image/png");

    expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
    const [, key, body, options] = writeS3ObjectMock.mock.calls[0]!;
    expect(key).toContain("media/");
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
        agentConfig: modelConfig("google"),
        workspace: workspace(),
      },
    );

    const file = parts.stored.find((part) => part.type === "file");
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

    // The picture still reaches the model as bytes, and the row keeps none
    // of them: this attachment names no file the channel could serve again.
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
        // Anthropic will not take audio, and with no workspace there is no
        // stored file to send the agent to instead.
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
    ).toEqual({ stored: [], turn: [] });
  });
});

describe("acceptsNativeMedia", () => {
  it("refuses a subtype the provider does not read", () => {
    // The bug this replaced matched on the top-level segment, so a table entry
    // of "audio" claimed audio/ogg on a provider that accepts no audio at all.
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
    // The file is still stored, and still not sent as a part OpenAI refuses.
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
      retryable: true,
    });

    expect(await ingestVoiceNote("openai").then(noteText)).toContain(
      "Read the file to try again before you answer",
    );
  });

  // A provider with no speech-to-text will not grow one on a retry, so telling
  // the agent to try again would only cost it a turn before it asks anyway.
  it("tells the agent not to retry what cannot work", async () => {
    transcribeAudioMock.mockResolvedValueOnce({
      status: "failed",
      reason: "anthropic has no transcription model",
      retryable: false,
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

    // The turn reads the bytes that just arrived; the row keeps the file id,
    // which is a few dozen bytes rather than a megabyte of base64.
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

  it("reads the bytes back through the channel that delivered them", async () => {
    const fetchMock = telegramFetch();
    const messages = await rehydrateStoredMedia(
      [storedMessage("file-77")],
      telegramConfig(),
    );

    const content = messages[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected message parts");
    const image = content.find((part) => part.type === "image");
    if (image?.type !== "image") throw new Error("expected an image part");
    expect(image.image).toEqual(PNG_BYTES);
    // The bot token is what makes the file readable, so the download has to go
    // through Telegram rather than straight at a URL.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("getFile")),
    ).toBe(true);
  });

  // Without this the conversation stays broken: the part is replayed on every
  // later turn, and a provider switch breaks messages that worked when stored.
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
              data: "https://core.example/media/sealed-token",
            },
          ],
        },
      ],
      modelConfig("openai"),
    );

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "listen to this" },
      {
        type: "text",
        text: unreadableMediaNote("voice.ogg", "audio/ogg"),
      },
    ]);
  });

  it("says a file the channel dropped is gone instead of failing the turn", async () => {
    telegramFetch({ ok: false });
    const messages = await rehydrateStoredMedia(
      [storedMessage("file-gone")],
      telegramConfig(),
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

  it("leaves a conversation with no references untouched", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ];

    expect(await rehydrateStoredMedia(messages, telegramConfig())).toBe(
      messages,
    );
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

// Every test past the first runs against a real server on the loopback: the
// transport seam maps the public names to 127.0.0.1 and exempts only that
// address from the denylist, so the sockets, redirects, and TLS handshake are
// the ones production opens — not an injected connection. The guard's own
// behavior is covered in isolate-pinned-fetch.test.ts; these tests prove the
// attachment path threads it correctly.
describe("readAttachmentBytes URL guard", () => {
  it("refuses a host that resolves to a private address", async (): Promise<void> => {
    // The URL comes out of the webhook body, so the sender picks the host. A
    // literal here, but a public name pointed at 127.0.0.1 fails the same check.
    await expect(
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

      // Byte-for-byte: the transport must never decode the body as text.
      expect(bytes.equals(payload)).toBe(true);
      // One lookup, one request carrying the original Host: nothing re-resolves
      // the name after validation, which is the DNS-rebind window this
      // transport exists to close.
      expect(lookups).toEqual(["public.test"]);
      expect(hostHeaders).toEqual([`public.test:${port}`]);
    });
  });

  it("speaks TLS to the pinned address under the original name", async (): Promise<void> => {
    // Connecting to an IP while verifying the certificate for `public.test`
    // only works if the hostname still rides along as the SNI servername —
    // the half of pinning that is easy to break without noticing.
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
    // The first hop passes because only the loopback is exempted; the second
    // has to fail on the production denylist the transport threads through
    // every hop.
    const server = createHttpServer((_request, response) => {
      response.writeHead(302, {
        location: "http://metadata.test/latest/meta-data/",
      });
      response.end();
    });

    await withServer(server, async (port): Promise<void> => {
      await expect(
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
      await expect(
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
      await expect(
        readAttachmentBytes(
          { type: "file", url: `http://public.test:${port}/big.bin` },
          loopbackTransport({ "public.test": "127.0.0.1" }),
        ),
      ).rejects.toThrow(/exceeded 25MB/);
    });
  });

  it("stops reading a body that outgrows the cap instead of buffering it whole", async (): Promise<void> => {
    // Chunked, so the size is knowable only from the bytes: the read has to be
    // the thing that stops, not a header check before it. The server offers at
    // most 30 MB, so the test failing open would still terminate.
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
      await expect(
        readAttachmentBytes(
          { type: "file", url: `http://public.test:${port}/endless.bin` },
          loopbackTransport({ "public.test": "127.0.0.1" }),
        ),
      ).rejects.toThrow(/exceeded 25MB/);
    });
  });
});

// Only the loopback exemption is granted; every other address still faces the
// real denylist, so the metadata redirect above fails on the same check
// production runs.
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

// The only part of a config the media path reads: which provider is running,
// which decides both what goes over natively and what audio is transcribed with.
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

// Stands in for Telegram: `getFile` names the path, the next call serves it.
function telegramFetch(
  options: { ok?: boolean } = {},
): ReturnType<typeof mock> {
  const fetchMock = mock(async (input: string | URL | Request) => {
    const url = String(input);
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
