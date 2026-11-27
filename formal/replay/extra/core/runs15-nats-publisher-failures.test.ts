import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as log from "../../../../apps/core/src/shared/log.ts";

const CORE_ROOT = new URL("../../../../apps/core/", import.meta.url).pathname;
const NATS_PATH = Bun.resolveSync("nats", CORE_ROOT);
const realNats = (await import(NATS_PATH)) as Record<string, unknown>;
const originalNatsUrl = process.env.NATS_URL;
let publishError: Error | null = null;

await mock.module(NATS_PATH, (): Record<string, unknown> => ({
  ...realNats,
  connect: async (): Promise<unknown> => {
    const closed = new Promise<void>((): void => {});

    return {
      info: { max_payload: 4096 },
      closed: (): Promise<void> => closed,
      flush: async (): Promise<void> => {},
      publish: (): void => {
        if (publishError) throw publishError;
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

const { LiveNatsPublisher } =
  await import("../../../../apps/core/src/harness/nats-publisher.ts");

const HEADERS = {
  accountId: "acct_1",
  agentId: "agent_1",
  conversationKey: "conversation-1",
  eventId: "event-1",
  connectionId: "socket-1",
};

beforeEach((): void => {
  publishError = null;
  process.env.NATS_URL = "nats://nats.test:4222";
});

afterAll((): void => {
  if (originalNatsUrl === undefined) delete process.env.NATS_URL;
  else process.env.NATS_URL = originalNatsUrl;
});

describe("LiveNatsPublisher failures", (): void => {
  test("a run without a broker streams nothing and does not throw", async (): Promise<void> => {
    delete process.env.NATS_URL;
    const error = spyOn(log, "logError");
    const publisher = new LiveNatsPublisher(HEADERS);

    await expect(
      publisher.publish({ type: "text-delta" }),
    ).resolves.toBeUndefined();

    expect(error.mock.calls.map(([message]): string => message)).toContain(
      "NATS connection unavailable; this run streams nothing",
    );
    error.mockRestore();
  });

  test("a publish the broker connection rejects is logged with its frame type", async (): Promise<void> => {
    publishError = new Error("connection closed");
    const error = spyOn(log, "logError");
    const publisher = new LiveNatsPublisher(HEADERS);

    await publisher.publish({ type: "text-delta" });

    expect(error).toHaveBeenCalledWith("NATS response publish failed", {
      eventId: "event-1",
      frameType: "text-delta",
      error: "connection closed",
    });
    error.mockRestore();
  });
});
