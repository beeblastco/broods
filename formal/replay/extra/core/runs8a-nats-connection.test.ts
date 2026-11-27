import { afterEach, describe, expect, mock, test } from "bun:test";

interface FakeConnection {
  closed: () => Promise<void>;
  flush: () => Promise<void>;
}

const tcpOptions: unknown[] = [];
const wsOptions: unknown[] = [];
let failConnect = false;
let failFlush = false;
let flushes = 0;
let closeConnection = (): void => {};

function fakeConnection(): FakeConnection {
  return {
    closed: (): Promise<void> =>
      new Promise<void>((resolve): void => {
        closeConnection = resolve;
      }),
    flush: async (): Promise<void> => {
      flushes += 1;
      if (failFlush) throw new Error("flush failed");
    },
  };
}

async function connectFake(
  seen: unknown[],
  options: unknown,
): Promise<FakeConnection> {
  seen.push(options);
  if (failConnect) throw new Error("connect failed");

  return fakeConnection();
}

const CORE_DIR = `${import.meta.dir}/../../../../apps/core/src/shared`;
const NATS_PATH = Bun.resolveSync("nats", CORE_DIR);
const NATS_WS_PATH = Bun.resolveSync("nats.ws", CORE_DIR);
const realNats = await import(NATS_PATH);
const realWs = await import(NATS_WS_PATH);

await mock.module(NATS_PATH, () => ({
  ...realNats,
  connect: (options: unknown): Promise<FakeConnection> =>
    connectFake(tcpOptions, options),
}));
await mock.module(NATS_WS_PATH, () => ({
  ...realWs,
  connect: (options: unknown): Promise<FakeConnection> =>
    connectFake(wsOptions, options),
}));

// Lazy so the client mocks above are in place first.
const { connectNats, flushObservabilityNats, getSharedNatsConn } =
  await import("../../../../apps/core/src/shared/nats.ts");

afterEach((): void => {
  tcpOptions.length = 0;
  wsOptions.length = 0;
  failConnect = false;
  failFlush = false;
  flushes = 0;
  delete process.env.NATS_URL;
  delete process.env.NATS_TOKEN;
});

describe("connectNats", (): void => {
  test.each([
    ["nats://host:4222", undefined, undefined, "tcp"],
    ["ws://host:4222", 100, undefined, "ws"],
    ["WSS://host", 100, -1, "ws"],
    ["host:4222", undefined, 0, "tcp"],
  ] as const)(
    "%s picks its transport",
    async (
      servers,
      timeout,
      maxReconnectAttempts,
      transport,
    ): Promise<void> => {
      await connectNats({
        servers: servers,
        token: "t",
        ...(timeout === undefined ? {} : { timeout: timeout }),
        ...(maxReconnectAttempts === undefined
          ? {}
          : { maxReconnectAttempts: maxReconnectAttempts }),
      });
      expect((transport === "ws" ? wsOptions : tcpOptions).length).toBe(1);
    },
  );
});

describe("shared connection", (): void => {
  test("no URL means no connection, and no flush", async (): Promise<void> => {
    process.env.NATS_URL = "   ";
    expect(getSharedNatsConn()).toBeNull();
    await flushObservabilityNats();
    expect(flushes).toBe(0);
  });

  test("a failed connect is retried by the next caller", async (): Promise<void> => {
    process.env.NATS_URL = "nats://host";
    failConnect = true;
    await expect(getSharedNatsConn()).rejects.toThrow("connect failed");
    failConnect = false;
    process.env.NATS_TOKEN = "  ";
    const first = getSharedNatsConn();
    const joined = getSharedNatsConn();
    expect(joined).toBe(first);
    const connection = await first;
    expect(await getSharedNatsConn()).toBe(connection);
    expect(tcpOptions).toEqual([
      expect.objectContaining({ servers: "nats://host", token: undefined }),
      expect.objectContaining({ servers: "nats://host", timeout: 3000 }),
    ]);
  });

  test("flush swallows a failure", async (): Promise<void> => {
    await flushObservabilityNats();
    failFlush = true;
    await flushObservabilityNats();
    expect(flushes).toBe(2);
  });

  test("a closed connection is forgotten", async (): Promise<void> => {
    closeConnection();
    await Promise.resolve();
    await Promise.resolve();
    await flushObservabilityNats();
    expect(flushes).toBe(0);
  });
});
