import { afterEach, describe, expect, test } from "bun:test";

import { isConnectionType } from "../../../../packages/convex/model/connections.ts";
import { createDiscordChannel } from "../../../../apps/core/src/shared/discord-channel.ts";
import {
  createPancakeActions,
  type PancakeSource,
} from "../../../../apps/core/src/shared/pancake-channel.ts";

interface PancakeAnswer {
  status: number;
  body: string;
}

const SOURCE: PancakeSource = {
  pageId: "page-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  messageType: "INBOX",
};

const originalFetch = globalThis.fetch;

function stubFetch(answers: PancakeAnswer[]): string[] {
  const urls: string[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(String(input as string | URL));
    const answer = answers.shift() ?? { status: 200, body: "{}" };

    return new Response(answer.body, { status: answer.status });
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: originalFetch.preconnect,
  });

  return urls;
}

function pictureFile(name: string): {
  url: string;
  name: string;
  mimeType: string;
  fetchData: () => Promise<Buffer>;
} {
  return {
    url: `https://files.example/${name}`,
    name: name,
    mimeType: "image/png",
    fetchData: async (): Promise<Buffer> => Buffer.from("png-bytes"),
  };
}

afterEach((): void => {
  globalThis.fetch = originalFetch;
});

describe("pancake attachments", () => {
  test("each file uploads, then posts with the caption on the first only", async (): Promise<void> => {
    const urls = stubFetch([
      { status: 200, body: '{"id":"content-1"}' },
      { status: 200, body: '{"success":true}' },
      { status: 200, body: '{"id":"content-2"}' },
      { status: 200, body: '{"success":true}' },
    ]);
    const actions = createPancakeActions("page-token", SOURCE, "sender-1");

    await actions.sendFiles?.(
      [pictureFile("a.png"), pictureFile("b.png")],
      "  a caption  ",
    );

    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("/pages/page-1/upload_contents");
  });

  test("no caption and no sender leaves the post bare", async (): Promise<void> => {
    const urls = stubFetch([
      { status: 200, body: '{"id":"content-3"}' },
      { status: 200, body: '{"success":true}' },
    ]);
    const actions = createPancakeActions("page-token", SOURCE);

    await actions.sendFiles?.([pictureFile("c.png")]);

    expect(urls).toHaveLength(2);
  });

  test.each<[string, PancakeAnswer, string]>([
    [
      "an error status with a message",
      { status: 400, body: '{"message":"too big"}' },
      "Pancake upload of d.png failed (400): too big",
    ],
    [
      "an ok status with no id",
      { status: 200, body: "{}" },
      "Pancake upload of d.png failed (200): {}",
    ],
    [
      "an empty body",
      { status: 500, body: "" },
      "Pancake upload of d.png failed (500): unknown_error",
    ],
  ])("%s fails the upload", async (_label, answer, message): Promise<void> => {
    stubFetch([answer]);
    const actions = createPancakeActions("page-token", SOURCE);

    await expect(actions.sendFiles?.([pictureFile("d.png")])).rejects.toThrow(
      message,
    );
  });

  test("no attachments sends nothing", async (): Promise<void> => {
    const urls = stubFetch([]);
    const actions = createPancakeActions("page-token", SOURCE);

    await actions.sendFiles?.([]);

    expect(urls).toHaveLength(0);
  });
});

describe("discord request signature", () => {
  test.each<[string, Record<string, string>]>([
    [
      "a bad signature",
      { "x-signature-ed25519": "00", "x-signature-timestamp": "1" },
    ],
    ["a missing timestamp", { "x-signature-ed25519": "00" }],
  ])("%s is refused", async (_label, headers): Promise<void> => {
    const channel = createDiscordChannel(
      "bot-token",
      "a".repeat(64),
      null,
      null,
    );

    const verdict = await channel.authenticate({
      method: "POST",
      path: "/",
      headers: headers,
      body: "{}",
    });

    expect(verdict).toBe(false);
  });
});

describe("connection types", () => {
  test.each<[unknown, boolean]>([
    ["chatgpt", true],
    ["openai", false],
    [undefined, false],
    [1, false],
  ])("%p is %p", (value, expected): void => {
    expect(isConnectionType(value)).toBe(expected);
  });
});
