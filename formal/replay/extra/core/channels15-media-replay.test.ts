import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";

type ModelMessage = Parameters<typeof sealConversationMedia>[0][number];
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type MediaData = Buffer | ArrayBuffer | string | URL;

const stored = new Map<string, Uint8Array>();

await mock.module("../../../../apps/core/src/shared/s3.ts", (): object => ({
  writeS3Object: async (
    _bucket: string,
    key: string,
    body: string | Uint8Array,
  ): Promise<number> => {
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    stored.set(key, bytes);

    return bytes.byteLength;
  },
  headS3Object: async (): Promise<null> => null,
  readS3Bytes: async (_bucket: string, key: string): Promise<Uint8Array> =>
    stored.get(key) ?? new Uint8Array(),
  readS3Text: async (): Promise<string> => "",
  s3ObjectExists: async (): Promise<boolean> => true,
  getS3ObjectUrl: async (): Promise<string> => "",
  putS3ObjectUrl: async (): Promise<string> => "",
  listS3Prefix: async (): Promise<never[]> => [],
  deleteS3Object: async (): Promise<void> => {},
  deleteS3Prefix: async (): Promise<number> => 0,
  copyS3Object: async (): Promise<void> => {},
  ensureS3DirectoryMarkers: async (): Promise<void> => {},
  isMissingS3Error: (): boolean => false,
}));

const { rehydrateStoredMedia, sealConversationMedia } =
  await import("../../../../apps/core/src/harness/channel-media.ts");

const ACCOUNT = "acct_1";
const NOTE = "[an earlier image is not shown here]";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CONFIG: AgentConfig = {
  model: { provider: "custom", modelId: "test-model" },
};

beforeEach((): void => {
  process.env.AWS_REGION = "us-east-1";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.MEDIA_TICKET_SECRET = "media-ticket-secret";
  process.env.PUBLIC_BASE_URL = "https://core.example";
  stored.clear();
});

function distinctPng(index: number): Buffer {
  return Buffer.concat([PNG, Buffer.from([index])]);
}

function userImage(index: number): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "image", image: distinctPng(index), mediaType: "image/png" },
    ],
  };
}

function toolImage(index: number): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "screenshot",
        output: {
          type: "content",
          value: [
            {
              type: "image-data",
              data: distinctPng(index).toString("base64"),
              mediaType: "image/png",
            },
          ],
        },
      },
    ],
  };
}

function userImages(count: number, offset: number): ModelMessage[] {
  return Array.from({ length: count }, (_value, index): ModelMessage =>
    userImage(offset + index),
  );
}

async function sealedImage(
  image: MediaData | { type: "data"; data: Buffer },
  asFile: boolean,
): Promise<UserMessage["content"]> {
  const content = (
    asFile
      ? [{ type: "file", data: image, mediaType: "image/png" }]
      : [{ type: "image", image: image, mediaType: "image/png" }]
  ) as UserMessage["content"];
  const [message] = await sealConversationMedia(
    [{ role: "user", content: content }],
    ACCOUNT,
  );

  return message?.role === "user" ? message.content : "";
}

describe("mediaBytes", (): void => {
  test.each<[string, MediaData]>([
    ["a byte array", distinctPng(1)],
    ["an array buffer", new Uint8Array(distinctPng(2)).buffer],
    [
      "a base64 data url",
      `data:image/png;base64,${distinctPng(3).toString("base64")}`,
    ],
    ["a bare base64 string", distinctPng(4).toString("base64")],
  ])("seals %s into a media link", async (_label, image): Promise<void> => {
    const content = await sealedImage(image, false);

    expect(JSON.stringify(content)).toContain("https://core.example/v1/media/");
  });

  test("seals file data wrapped as typed data", async (): Promise<void> => {
    const content = await sealedImage(
      { type: "data", data: distinctPng(5) },
      true,
    );

    expect(JSON.stringify(content)).toContain("https://core.example/v1/media/");
  });

  test.each<[string, MediaData]>([
    ["a remote url string", "https://cdn.example/a.png"],
    ["a url object", new URL("https://cdn.example/b.png")],
  ])("leaves %s unsealed", async (_label, image): Promise<void> => {
    const content = await sealedImage(image, false);

    expect(JSON.stringify(content)).not.toContain("/v1/media/");
  });
});

describe("withOldMediaOmitted", (): void => {
  test("drops the oldest pictures in whole batches and keeps the newest", async (): Promise<void> => {
    const sealed = await sealConversationMedia(
      [...userImages(24, 100), toolImage(0)],
      ACCOUNT,
    );

    const replay = await rehydrateStoredMedia(sealed, CONFIG, ACCOUNT);

    expect(JSON.stringify(replay).split(NOTE)).toHaveLength(11);
    expect(JSON.stringify(replay.slice(0, 10))).not.toContain("image/png");
    expect(JSON.stringify(replay.slice(10))).not.toContain(NOTE);
    expect(JSON.stringify(replay.at(-1))).toContain("image/png");
  });

  test("keeps every picture while under the replay limit", async (): Promise<void> => {
    const sealed = await sealConversationMedia(userImages(20, 0), ACCOUNT);

    const replay = await rehydrateStoredMedia(sealed, CONFIG, ACCOUNT);

    expect(JSON.stringify(replay)).not.toContain(NOTE);
  });
});
