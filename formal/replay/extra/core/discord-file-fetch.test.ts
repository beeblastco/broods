import { describe, expect, mock, test } from "bun:test";
import { Readable } from "node:stream";

interface FakeAnswer {
  status: number;
  body: string;
}

const requested: { host: string | undefined; path: string | undefined }[] = [];
let address = "93.184.216.34";
let answer: FakeAnswer = { status: 200, body: "" };

await mock.module("node:dns/promises", () => ({
  lookup: async (): Promise<{ address: string; family: number }[]> => [
    { address: address, family: 4 },
  ],
}));

function fakeRequest(
  options: { headers: Record<string, string>; path: string },
  onResponse: (response: Readable) => void,
): { on: () => void; end: () => void; destroy: () => void } {
  requested.push({ host: options.headers["Host"], path: options.path });

  return {
    on: (): void => {},
    destroy: (): void => {},
    end: (): void => {
      const response = Object.assign(
        Readable.from([Buffer.from(answer.body)]),
        {
          statusCode: answer.status,
          headers: {},
        },
      );
      onResponse(response);
    },
  };
}

await mock.module("node:https", () => ({
  default: { request: fakeRequest },
  request: fakeRequest,
}));

// Lazy so the module mocks above are in place first.
const { createDiscordChannel } =
  await import("../../../../apps/core/src/shared/discord-channel.ts");
const { discordForwarderToken } =
  await import("../../../../apps/core/src/shared/discord-wire.ts");

async function attachmentReader(): Promise<() => Promise<Buffer>> {
  const adapter = createDiscordChannel(
    "bot-token",
    "0".repeat(64),
    new Set(["channel-1"]),
    null,
  );
  const parsed = await adapter.parse({
    method: "POST",
    rawPath: "/v1/runs",
    rawQueryString: "",
    headers: { "x-discord-gateway-token": discordForwarderToken("bot-token") },
    body: JSON.stringify({
      type: "GATEWAY_MESSAGE_CREATE",
      data: {
        id: "m1",
        channel_id: "channel-1",
        content: "",
        guild_id: "guild-1",
        mentions: [],
        mention_roles: [],
        attachments: [
          {
            id: "a1",
            url: "https://cdn.discordapp.com/attachments/1/2/chart.png?ex=abc",
            filename: "chart.png",
            content_type: "image/png",
          },
        ],
        author: { id: "user-1", username: "ada", bot: false },
      },
    }),
  });
  if (parsed.kind !== "message") throw new Error(`got ${parsed.kind}`);
  const fetchData = parsed.message.attachments?.[0]?.fetchData;
  if (!fetchData) throw new Error("no fetchData");

  return fetchData as () => Promise<Buffer>;
}

describe("a Discord attachment's bytes", (): void => {
  test("come from the CDN url over the pinned address", async (): Promise<void> => {
    address = "93.184.216.34";
    answer = { status: 200, body: "png-bytes" };
    const read = await attachmentReader();

    const bytes = await read();

    expect(bytes.toString()).toBe("png-bytes");
    expect(requested.at(-1)).toEqual({
      host: "cdn.discordapp.com",
      path: "/attachments/1/2/chart.png?ex=abc",
    });
  });

  test("fail on a non-2xx answer", async (): Promise<void> => {
    address = "93.184.216.34";
    answer = { status: 404, body: "gone" };
    const read = await attachmentReader();

    await expect(read()).rejects.toThrow("Discord answered 404");
  });

  test("are refused when the host resolves to a private address", async (): Promise<void> => {
    address = "10.0.0.5";
    answer = { status: 200, body: "secret" };
    const read = await attachmentReader();

    await expect(read()).rejects.toThrow("blocked private or metadata address");
  });
});
