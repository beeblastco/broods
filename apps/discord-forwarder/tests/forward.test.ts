import { afterEach, describe, expect, it } from "bun:test";
import type { MessageCreate } from "../src/discord.ts";
import { forwardMessageCreate, type ForwardTarget } from "../src/forward.ts";

const MESSAGE: MessageCreate = {
  id: "message-1",
  channel_id: "channel-1",
  content: "ship it",
  guild_id: "guild-1",
  // No `bot` flag, which is what Discord sends for a human author.
  author: { id: "user-1", username: "ada" },
};

const TARGETS: ForwardTarget[] = [
  {
    agentId: "agent-1",
    agentName: "support",
    webhookUrl: "https://gateway.example.com/webhooks/account-1/discord",
  },
  {
    agentId: "agent-2",
    agentName: "triage",
    webhookUrl: "https://gateway.example.com/webhooks/account-1/dev/e1/discord",
  },
];

const realFetch = globalThis.fetch;

interface Capture {
  body: unknown;
  headers: Record<string, string>;
  url: string;
}

function captureFetch(status = 200): Capture[] {
  const calls: Capture[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      url: String(input),
    });

    return new Response("", { status: status });
  }) as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("forwarding a gateway message", () => {
  it("posts the payload verbatim under the shape core accepts", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TARGETS[0]!.webhookUrl);
    expect(calls[0]!.headers["x-discord-gateway-token"]).toBe("token-a");
    expect(calls[0]!.body).toEqual({
      type: "GATEWAY_MESSAGE_CREATE",
      data: MESSAGE,
    });
  });

  it("leaves a missing author.bot flag alone", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]);

    const data = (calls[0]!.body as { data: { author: unknown } }).data;
    expect(data.author).toEqual({ id: "user-1", username: "ada" });
  });

  it("adds the thread object Discord leaves out", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(
      { ...MESSAGE, channel_id: "thread-1" },
      { id: "thread-1", parent_id: "channel-1" },
      "token-a",
      [TARGETS[0]!],
    );

    expect(calls[0]!.body).toMatchObject({
      data: {
        channel_id: "thread-1",
        thread: { id: "thread-1", parent_id: "channel-1" },
      },
    });
  });

  it("fans one event out to every webhook the token serves", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(MESSAGE, null, "token-a", TARGETS);

    expect(calls.map((call) => call.url)).toEqual(
      TARGETS.map((target) => target.webhookUrl),
    );
  });

  it("survives a webhook rejecting the delivery", async () => {
    captureFetch(500);

    expect(
      forwardMessageCreate(MESSAGE, null, "token-a", TARGETS),
    ).resolves.toBeUndefined();
  });
});
