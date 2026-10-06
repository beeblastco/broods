import { afterEach, describe, expect, it } from "bun:test";
import type { ForwardTarget } from "../../discord-forwarder/src/forward.ts";
import { forwardedEvent, forwardRoomEvent } from "../src/forward.ts";

const TARGETS: ForwardTarget[] = [
  {
    agentId: "agent-1",
    agentName: "support",
    webhookUrl: "https://gateway.dev.example.com/v1/webhooks/a/dev/e1/matrix",
  },
  {
    agentId: "agent-2",
    agentName: "support",
    webhookUrl: "https://gateway.example.com/v1/webhooks/a/matrix",
  },
];

const realFetch = globalThis.fetch;

interface Capture {
  body: unknown;
  headers: Record<string, string>;
  url: string;
}

afterEach((): void => {
  globalThis.fetch = realFetch;
});

describe("forwarding a room message", () => {
  const event = forwardedEvent({
    encrypted: true,
    event: {
      content: { body: "ship it", msgtype: "m.text" },
      event_id: "$event-1",
      origin_server_ts: 1_700_000_000_000,
      sender: "@ada:example.org",
      type: "m.room.message",
    },
    roomId: "!room:example.org",
    senderName: "Ada",
    userId: "@owner:example.org",
  });

  it("posts the contract shape with the access token header", async () => {
    const calls = captureFetch();
    await forwardRoomEvent(event, "token-a", [TARGETS[0]!]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TARGETS[0]!.webhookUrl);
    expect(calls[0]!.headers["x-matrix-access-token"]).toBe("token-a");
    expect(calls[0]!.body).toEqual({
      type: "MATRIX_ROOM_EVENT",
      encrypted: true,
      event: {
        content: { body: "ship it", msgtype: "m.text" },
        event_id: "$event-1",
        origin_server_ts: 1_700_000_000_000,
        sender: "@ada:example.org",
        type: "m.room.message",
      },
      roomId: "!room:example.org",
      senderName: "Ada",
      userId: "@owner:example.org",
    });
  });

  // `/sync` events carry `unsigned` and friends; the contract names five fields.
  it("drops event fields the contract does not name", () => {
    const trimmed = forwardedEvent({
      encrypted: false,
      event: {
        ...event.event,
        unsigned: { age: 5 },
      } as typeof event.event,
      roomId: event.roomId,
      senderName: undefined,
      userId: event.userId,
    });

    expect(Object.keys(trimmed.event).sort()).toEqual([
      "content",
      "event_id",
      "origin_server_ts",
      "sender",
      "type",
    ]);
    expect(JSON.parse(JSON.stringify(trimmed))).not.toHaveProperty(
      "senderName",
    );
  });

  it("fans one event out to every webhook the token serves", async () => {
    const calls = captureFetch();
    await forwardRoomEvent(event, "token-a", TARGETS);

    expect(calls.map((call): string => call.url)).toEqual(
      TARGETS.map((target): string => target.webhookUrl),
    );
  });

  it("survives a webhook rejecting the delivery", async () => {
    captureFetch(500);

    await expect(
      forwardRoomEvent(event, "token-a", TARGETS),
    ).resolves.toBeUndefined();
  });
});

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
