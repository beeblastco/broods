import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realNats from "nats";

interface FakeConnection {
  options: Record<string, unknown>;
  published: { subject: string; data: Uint8Array }[];
  close: () => void;
}

const MAX_PAYLOAD = 4096;
const connections: FakeConnection[] = [];
const originalNatsUrl = process.env.NATS_URL;

// Only the dial is faked; the subject and stream helpers stay real.
mock.module("nats", () => ({
  ...realNats,
  connect: async (options: Record<string, unknown>): Promise<unknown> => {
    let close = (): void => {};
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const fake: FakeConnection = {
      options: options,
      published: [],
      close: close,
    };
    connections.push(fake);

    return {
      info: { max_payload: MAX_PAYLOAD },
      closed: (): Promise<void> => closed,
      flush: async (): Promise<void> => {},
      publish: (subject: string, data: Uint8Array): void => {
        fake.published.push({ subject: subject, data: data });
      },
      jetstreamManager: async (): Promise<unknown> => ({
        streams: {
          info: async (): Promise<unknown> => ({}),
          update: async (): Promise<unknown> => ({}),
        },
      }),
    };
  },
}));

const { getSharedNatsConn } = await import("../src/shared/nats.ts");
const { LiveNatsPublisher } = await import("../src/harness/nats-publisher.ts");

beforeEach(() => {
  process.env.NATS_URL = "nats://nats.test:4222";
});

afterAll(() => {
  if (originalNatsUrl === undefined) delete process.env.NATS_URL;
  else process.env.NATS_URL = originalNatsUrl;
});

describe("shared NATS connection", () => {
  it("reconnects forever and dials again once the connection closes", async (): Promise<void> => {
    const first = await getSharedNatsConn();
    const again = await getSharedNatsConn();

    expect(again).toBe(first);
    expect(connections.at(-1)?.options.maxReconnectAttempts).toBe(-1);

    const dialed = connections.length;
    connections.at(-1)!.close();
    await Bun.sleep(0);
    const next = await getSharedNatsConn();

    // A closed connection never recovers, so the memo must not hand it back.
    expect(next).not.toBe(first);
    expect(connections.length).toBe(dialed + 1);
  });
});

describe("LiveNatsPublisher", () => {
  it("publishes an oversized frame as its type with the payload dropped", async (): Promise<void> => {
    const publisher = new LiveNatsPublisher({
      accountId: "acct_1",
      agentId: "agent_1",
      conversationKey: "conversation-1",
      eventId: "event-1",
      connectionId: "socket-1",
    });

    await publisher.publish({ type: "text-delta", delta: "hi" });
    await publisher.publish({
      type: "tool-result",
      toolCallId: "call-1",
      output: "x".repeat(MAX_PAYLOAD * 2),
    });
    await publisher.close();

    const frames = connections
      .at(-1)!
      .published.map((message): Record<string, unknown> =>
        JSON.parse(new TextDecoder().decode(message.data)),
      );
    expect(frames.map((frame) => frame.data)).toEqual([
      { type: "text-delta", delta: "hi" },
      {
        type: "tool-result",
        truncated: true,
        originalBytes: expect.any(Number),
        toolCallId: "call-1",
      },
    ]);
    expect(frames[1]!.sequence).toBe(2);
  });
});
