import { afterAll, describe, expect, it, mock } from "bun:test";

interface FakeConnection {
  label: string;
  options: Record<string, unknown>;
  flushes: number;
  flushError: Error | null;
  close: () => void;
  getMessage: (
    stream: string,
    query: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

const dialed: FakeConnection[] = [];
let dialFailures = 0;
const originalUrl = process.env.NATS_URL;
const originalToken = process.env.NATS_TOKEN;

function fakeDial(
  label: string,
): (options: Record<string, unknown>) => Promise<unknown> {
  return async (options): Promise<unknown> => {
    if (dialFailures > 0) {
      dialFailures -= 1;
      throw new Error("broker unreachable");
    }
    let close = (): void => {};
    const closed = new Promise<void>((resolve): void => {
      close = resolve;
    });
    const fake: FakeConnection = {
      label: label,
      options: options,
      flushes: 0,
      flushError: null,
      close: close,
      getMessage: async (): Promise<Record<string, unknown>> => ({
        seq: 17,
        subject: "v1.a.b.ws.response.c",
      }),
    };
    dialed.push(fake);

    return {
      closed: (): Promise<void> => closed,
      flush: async (): Promise<void> => {
        fake.flushes += 1;
        if (fake.flushError) throw fake.flushError;
      },
      jetstreamManager: async (): Promise<unknown> => ({
        streams: {
          getMessage: (
            stream: string,
            query: Record<string, unknown>,
          ): Promise<Record<string, unknown>> => fake.getMessage(stream, query),
        },
      }),
    };
  };
}

const CORE_SRC = import.meta
  .resolve("../../../../apps/core/src/shared/nats.ts")
  .replace("file://", "");
const natsPath = Bun.resolveSync("nats", CORE_SRC);
const natsWsPath = Bun.resolveSync("nats.ws", CORE_SRC);
const realNats: Record<string, unknown> = await import(natsPath);
const realNatsWs: Record<string, unknown> = await import(natsWsPath);

await mock.module(natsPath, (): Record<string, unknown> => ({
  ...realNats,
  connect: fakeDial("tcp"),
}));
await mock.module(natsWsPath, (): Record<string, unknown> => ({
  ...realNatsWs,
  connect: fakeDial("ws"),
}));

// The preloaded logger holds an uninstrumented copy with its own state: load a fresh one.
delete require.cache[CORE_SRC];
const nats: typeof import("../../../../apps/core/src/shared/nats.ts") =
  await import(CORE_SRC);

afterAll((): void => {
  if (originalUrl === undefined) delete process.env.NATS_URL;
  else process.env.NATS_URL = originalUrl;
  if (originalToken === undefined) delete process.env.NATS_TOKEN;
  else process.env.NATS_TOKEN = originalToken;
});

describe("observability subjects", (): void => {
  it("keys the subject on the encoded stage and the endpoint", (): void => {
    expect(nats.logsSubject("acct", "shop", "dev/1", "ep_1")).toBe(
      "v1.acct.shop.ZGV2LzE.logs.ep_1",
    );
    expect(nats.tracesSubject("acct", "shop", "dev/1", "ep_1")).toBe(
      "v1.acct.shop.ZGV2LzE.traces.ep_1",
    );
  });
});

describe("connectNats", (): void => {
  it("dials a websocket url through nats.ws with the default timeout", async (): Promise<void> => {
    await nats.connectNats({ servers: "wss://nats.test", token: "t" });

    expect(dialed.at(-1)?.label).toBe("ws");
    expect(dialed.at(-1)?.options).toEqual({
      servers: "wss://nats.test",
      token: "t",
      timeout: 5000,
    });
  });

  it("dials any other url over tcp and passes the reconnect limit", async (): Promise<void> => {
    await nats.connectNats({
      servers: "nats://nats.test:4222",
      timeout: 250,
      maxReconnectAttempts: -1,
    });

    expect(dialed.at(-1)?.label).toBe("tcp");
    expect(dialed.at(-1)?.options).toEqual({
      servers: "nats://nats.test:4222",
      token: undefined,
      timeout: 250,
      maxReconnectAttempts: -1,
    });
  });
});

describe("shared connection", (): void => {
  it("has nothing to flush or share before it is configured", async (): Promise<void> => {
    delete process.env.NATS_URL;
    const before = dialed.length;

    expect(nats.getSharedNatsConn()).toBeNull();
    await nats.flushObservabilityNats();
    expect(dialed.length).toBe(before);
  });

  it("dials once, reuses the open connection, flushes it and redials after it closes", async (): Promise<void> => {
    process.env.NATS_URL = " nats://nats.test:4222 ";
    process.env.NATS_TOKEN = " secret ";
    const before = dialed.length;
    const connection = await nats.getSharedNatsConn();
    expect(await nats.getSharedNatsConn()).toBe(connection);
    expect(dialed.length).toBe(before + 1);
    const fake = dialed.at(-1)!;
    expect(fake.options).toEqual({
      servers: "nats://nats.test:4222",
      token: "secret",
      timeout: 3000,
      maxReconnectAttempts: -1,
    });

    await nats.flushObservabilityNats();
    expect(fake.flushes).toBe(1);
    fake.flushError = new Error("flush refused");
    await nats.flushObservabilityNats();
    expect(fake.flushes).toBe(2);

    fake.close();
    await Bun.sleep(1);
    const redialed = await nats.getSharedNatsConn();
    expect(redialed).not.toBe(connection);
    expect(dialed.length).toBe(before + 2);
    dialed.at(-1)?.close();
    await Bun.sleep(1);
  });

  it("forgets a failed dial so the next caller tries again", async (): Promise<void> => {
    process.env.NATS_URL = "nats://nats.test:4222";
    delete process.env.NATS_TOKEN;
    dialFailures = 1;

    await expect(nats.getSharedNatsConn()).rejects.toThrow(
      "broker unreachable",
    );
    const recovered = await nats.getSharedNatsConn();

    expect(recovered).toBeDefined();
    expect(dialed.at(-1)?.options["token"]).toBeUndefined();
  });
});

describe("response stream lookups", (): void => {
  it("reads the last sequence of a conversation, null when the read fails", async (): Promise<void> => {
    const connection = await nats.connectNats({ servers: "nats://nats.test" });
    const fake = dialed.at(-1)!;
    const query = {
      connection: connection,
      accountId: "a",
      agentId: "b",
      conversationKey: "c",
    };

    expect(await nats.conversationLastSequence(query)).toBe(17);
    fake.getMessage = async (): Promise<Record<string, unknown>> => {
      throw new Error("no message");
    };
    expect(await nats.conversationLastSequence(query)).toBeNull();
  });

  it("names the subject a retained sequence belongs to, null once evicted", async (): Promise<void> => {
    const connection = await nats.connectNats({ servers: "nats://nats.test" });
    const fake = dialed.at(-1)!;

    expect(await nats.retainedMessageSubject(connection, 5)).toBe(
      "v1.a.b.ws.response.c",
    );
    fake.getMessage = async (): Promise<Record<string, unknown>> => {
      throw new Error("sequence evicted");
    };
    expect(await nats.retainedMessageSubject(connection, 5)).toBeNull();
  });
});
