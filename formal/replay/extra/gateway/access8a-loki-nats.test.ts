import { afterEach, expect, mock, test } from "bun:test";
import type { NatsConnection } from "nats.ws";
import {
  cleanupObservabilitySocket,
  handleObservabilityMessage,
  openObservabilitySocket,
  type ObservabilityGatewayData,
} from "../../../../apps/gateway/src/observability.ts";

const natsModule = await import("../../../../apps/core/src/shared/nats.ts");
const SANDBOX_ID = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const realFetch = globalThis.fetch;
const connects: Array<{ servers: string; token: string | undefined }> = [];
let connectResult: () => Promise<NatsConnection> = async () => {
  throw new Error("connect not configured");
};

await mock.module("../../../../apps/core/src/shared/nats.ts", () => ({
  ...natsModule,
  connectNats: (options: {
    servers: string;
    token: string | undefined;
  }): Promise<NatsConnection> => {
    connects.push({ servers: options.servers, token: options.token });

    return connectResult();
  },
}));

const { gatewayConfigFromEnv } =
  await import("../../../../apps/gateway/src/main.ts");

afterEach((): void => {
  globalThis.fetch = realFetch;
  delete process.env["LOKI_URL"];
  delete process.env["NATS_URL"];
  delete process.env["NATS_TOKEN"];
  delete process.env["BROODS_CORE_URL"];
  delete process.env["TERMINAL_TICKET_SECRET"];
});

test.each([
  [
    "a network failure",
    (): Promise<Response> => Promise.reject(new TypeError("socket hang up")),
    "socket hang up",
  ],
  [
    "an HTTP error",
    (): Promise<Response> =>
      Promise.resolve(new Response(null, { status: 502 })),
    "Loki query failed with HTTP 502",
  ],
])(
  "a sandbox backfill reports %s to the tab",
  async (
    _name: string,
    answer: () => Promise<Response>,
    error: string,
  ): Promise<void> => {
    process.env["LOKI_URL"] = "http://loki.example";
    globalThis.fetch = answer as unknown as typeof fetch;
    const { socket, sent } = fakeSocket();
    openObservabilitySocket(socket);

    await handleObservabilityMessage(
      socket,
      JSON.stringify({
        type: "subscribe",
        stream: "logs",
        backfill: 5,
        sandboxId: SANDBOX_ID,
      }),
      async (): Promise<NatsConnection> => {
        throw new Error("sandbox tails never reach NATS");
      },
    );
    await settle();

    expect(sent).toContainEqual({
      type: "backfill",
      stream: "logs",
      entries: [],
      error: error,
    });
    cleanupObservabilitySocket(socket);
  },
);

test("the gateway connection needs NATS_URL, retries a failure and shares a success", async (): Promise<void> => {
  process.env["TERMINAL_TICKET_SECRET"] = "access8a-ticket-secret";
  process.env["BROODS_CORE_URL"] = "http://core.example";
  const connection = {
    closed: (): Promise<void> => new Promise<void>((): void => {}),
    jetstream: (): never => {
      throw new Error("no stream in this test");
    },
  } as unknown as NatsConnection;
  // oxlint-disable-next-line typescript/unbound-method -- called detached, the way the code under test calls it
  const spend = gatewayConfigFromEnv().spentTickets.spend;

  await spend("ticket-without-url").catch((): boolean => false);
  expect(connects).toEqual([]);

  process.env["NATS_URL"] = " nats://one.example ";
  process.env["NATS_TOKEN"] = " secret ";
  connectResult = async (): Promise<NatsConnection> => {
    throw new Error("refused");
  };
  await spend("ticket-after-refusal").catch((): boolean => false);
  await settle();
  expect(connects).toEqual([
    { servers: "nats://one.example", token: "secret" },
  ]);

  connectResult = async (): Promise<NatsConnection> => connection;
  await spend("ticket-connected").catch((): boolean => false);
  await settle();
  await spend("ticket-shared").catch((): boolean => false);
  expect(connects).toHaveLength(2);
});

function fakeSocket(): {
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    getBufferedAmount: (): number => 0,
    send: (value: string): number => sent.push(JSON.parse(value)),
    close: (): void => {},
    data: {
      kind: "observability",
      scope: {
        accountId: "acct-1",
        projectSlug: "shop",
        stageSlug: "dev",
        endpointIds: [],
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      token: "bdts_fixture",
    },
  } as unknown as Bun.ServerWebSocket<ObservabilityGatewayData>;

  return { socket: socket, sent: sent };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, 20);
  });
}
