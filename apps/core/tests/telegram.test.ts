/**
 * Telegram outbound action tests.
 * Cover markdown formatting, chunking, and fallback send behavior here.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { sendMessage } from "../functions/_shared/telegram.ts";

describe("telegram outbound actions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("formats markdown as Telegram HTML", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [emptyResponse(200)]);

    await sendMessage(
      "bot-token",
      123,
      "# Title\nUse **bold** and _italics_ with `code` plus [site](https://example.com)\n\n```ts\nconst x = 1 < 2;\n```",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(calls[0]?.jsonBody).toEqual({
      chat_id: 123,
      text: "<b>Title</b>\nUse <b>bold</b> and <i>italics</i> with <code>code</code> plus <a href=\"https://example.com\">site</a>\n\n<pre><code class=\"language-ts\">const x = 1 &lt; 2;</code></pre>",
      parse_mode: "HTML",
    });
  });

  it("splits oversized HTML messages into deterministic chunks", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [emptyResponse(200), emptyResponse(200)]);

    await sendMessage("bot-token", 123, `${"a".repeat(4090)}\n${"b".repeat(20)}`);

    expect(calls).toHaveLength(2);
    expect((calls[0]?.jsonBody as { text: string }).text).toBe("a".repeat(4090));
    expect((calls[1]?.jsonBody as { text: string }).text).toBe(`\n${"b".repeat(20)}`);
    expect(calls[0]?.jsonBody).toEqual({
      chat_id: 123,
      text: "a".repeat(4090),
      parse_mode: "HTML",
    });
    expect(calls[1]?.jsonBody).toEqual({
      chat_id: 123,
      text: `\n${"b".repeat(20)}`,
      parse_mode: "HTML",
    });
  });

  it("falls back to plain text when Telegram rejects the HTML payload", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [
      textResponse(400, "Bad Request: unsupported HTML"),
      emptyResponse(200),
    ]);

    await sendMessage("bot-token", 123, "Hello **world**");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.jsonBody).toEqual({
      chat_id: 123,
      text: "Hello <b>world</b>",
      parse_mode: "HTML",
    });
    expect(calls[1]?.jsonBody).toEqual({
      chat_id: 123,
      text: "Hello world",
    });
  });

  it("throws the fallback response body when both Telegram sends fail", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [
      textResponse(400, "Bad Request: unsupported HTML"),
      textResponse(500, "telegram exploded"),
    ]);

    await expect(sendMessage("bot-token", 123, "`oops`")).rejects.toThrow(
      "Telegram sendMessage failed (500): telegram exploded",
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.jsonBody).toEqual({
      chat_id: 123,
      text: "oops",
    });
  });
});

interface FetchCall {
  jsonBody: unknown;
  url: string;
}

function createFetchMock(calls: FetchCall[], responses: Response[]): typeof fetch {
  return (async (input, init) => {
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }

    calls.push({
      url: String(input),
      jsonBody: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    return response;
  }) as typeof fetch;
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}
