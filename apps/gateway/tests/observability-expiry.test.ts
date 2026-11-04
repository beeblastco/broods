import { afterEach, expect, jest, test } from "bun:test";
import {
  openStageSessionTicket,
  sealStageSessionTicket,
  type StageSessionTicket,
} from "../../../packages/convex/model/stageSessionTicket.ts";
import type { ObservabilityServerMessage } from "../../../packages/broods/src/observability-contracts.ts";
import {
  createGateway,
  type GatewayConfig,
  type GatewayData,
} from "../src/main.ts";
import {
  cleanupObservabilitySocket,
  handleObservabilityMessage,
  openObservabilitySocket,
  watchObservabilityLifetime,
  type ObservabilityGatewayData,
} from "../src/observability.ts";
import { RateLimiter } from "../src/rate-limiter.ts";

const SECRET = "observability-expiry-ticket-secret";
const OWN_TRACE_ID = "acb92f3577b34da6a3ce929d0e0e4736";
const OTHER_TRACE_ID = "bcb92f3577b34da6a3ce929d0e0e4736";
const realFetch = globalThis.fetch;

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

test("an observability socket closes at its stage ticket's expiry and reads nothing after", async (): Promise<void> => {
  const originalTempoUrl = process.env.TEMPO_URL;
  const ticket: StageSessionTicket = {
    accountId: "expiry-account",
    endpointId: "expiry-endpoint",
    projectId: "expiry-project-id",
    projectSlug: "expiry-project",
    stageId: "expiry-stage-id",
    stageSlug: "development",
    expiresAt: Date.now() + 1000,
  };
  const token = await sealStageSessionTicket(ticket, SECRET);
  let traceRequests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async function (request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/v1/internal/observability-scope") {
        const presented = request.headers.get("authorization")?.slice(7) ?? "";
        const opened = await openStageSessionTicket(presented, SECRET);
        if (!opened) return new Response(null, { status: 401 });

        return Response.json({
          accountId: opened.accountId,
          projectSlug: opened.projectSlug,
          stageSlug: opened.stageSlug,
          endpointIds: [opened.endpointId],
          expiresAt: opened.expiresAt,
        });
      }
      if (path.startsWith("/api/traces/")) {
        traceRequests += 1;

        return Response.json(
          tracePayload(path.slice("/api/traces/".length), ticket),
        );
      }

      return new Response(null, { status: 404 });
    },
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  process.env.TEMPO_URL = upstreamUrl;
  const gateway = createGateway(gatewayConfig(upstreamUrl));
  const server = Bun.serve<GatewayData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: gateway.fetch,
    websocket: gateway.websocket,
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/v1/projects/${ticket.projectSlug}/stages/${ticket.stageSlug}/observability/ws`,
    ["broods.v1", `broods.token.${token}`],
  );
  try {
    await openedSocket(socket);
    const closed = new Promise<CloseEvent>((resolve): void => {
      socket.addEventListener("close", resolve, { once: true });
    });

    const ownReply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "fetchTrace", traceId: OWN_TRACE_ID }));
    expect(await ownReply).toMatchObject({
      type: "backfill",
      stream: "traces",
      entries: [{ traceId: OWN_TRACE_ID }],
    });
    const otherReply = nextMessage(socket);
    socket.send(
      JSON.stringify({ type: "fetchTrace", traceId: OTHER_TRACE_ID }),
    );
    expect(await otherReply).toMatchObject({
      type: "backfill",
      stream: "traces",
      entries: [],
      error: "Trace not found in this stage. Traces are kept 30 days",
    });
    expect(traceRequests).toBe(2);

    const close = await closed;
    const closedAt = Date.now();
    expect(close.code).toBe(4419);
    expect(close.reason).toBe("Stage session expired");
    expect(closedAt).toBeGreaterThanOrEqual(ticket.expiresAt);
    expect(closedAt).toBeLessThan(ticket.expiresAt + 1000);
    expect(traceRequests).toBe(2);
  } finally {
    socket.close();
    gateway.closeSockets(1000, "test complete");
    await server.stop(true);
    await upstream.stop(true);
    if (originalTempoUrl === undefined) delete process.env.TEMPO_URL;
    else process.env.TEMPO_URL = originalTempoUrl;
  }
});

test("a socket past its ticket is closed by its next message even before the expiry timer runs", async (): Promise<void> => {
  let upstreamCalls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    upstreamCalls += 1;

    return Response.json({});
  }) as unknown as typeof fetch;
  const { socket, sent, closes } = fakeSocket(Date.now() - 1);
  openObservabilitySocket(socket);

  await handleObservabilityMessage(
    socket,
    JSON.stringify({ type: "fetchTrace", traceId: OWN_TRACE_ID }),
    async () => {
      throw new Error("no NATS here");
    },
  );

  expect(closes).toEqual([4419]);
  expect(sent).toEqual([]);
  expect(upstreamCalls).toBe(0);
  cleanupObservabilitySocket(socket);
});

test("core is asked again every minute, and only a refusal closes the socket", async (): Promise<void> => {
  jest.useFakeTimers();
  const answers: number[] = [503, 401];
  const asked: string[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    asked.push(new Headers(init?.headers).get("authorization") ?? "");

    return new Response(null, { status: answers.shift() });
  }) as unknown as typeof fetch;
  const { socket, closes } = fakeSocket(Date.now() + 15 * 60_000);
  openObservabilitySocket(socket);
  watchObservabilityLifetime(socket, "http://core.example");

  // Core is down: the socket stays.
  jest.advanceTimersByTime(60_000);
  await waitFor((): boolean => asked.length === 1);
  expect(closes).toEqual([]);

  // Core refuses the ticket now: its account was suspended.
  jest.advanceTimersByTime(60_000);
  await waitFor((): boolean => closes.length === 1);
  expect(closes).toEqual([4401]);
  expect(asked).toEqual(["Bearer bdts_fixture", "Bearer bdts_fixture"]);
  cleanupObservabilitySocket(socket);
});

function fakeSocket(expiresAt: number): {
  socket: Bun.ServerWebSocket<ObservabilityGatewayData>;
  sent: unknown[];
  closes: number[];
} {
  const sent: unknown[] = [];
  const closes: number[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    getBufferedAmount: (): number => 0,
    send: (value: string): number => sent.push(JSON.parse(value)),
    close: (code: number): number => closes.push(code),
    data: {
      kind: "observability",
      scope: {
        accountId: "expiry-account",
        projectSlug: "expiry-project",
        stageSlug: "development",
        endpointIds: [],
        expiresAt: expiresAt,
      },
      token: "bdts_fixture",
    },
  } as unknown as Bun.ServerWebSocket<ObservabilityGatewayData>;

  return { socket: socket, sent: sent, closes: closes };
}

// Drains the microtasks a fired fake timer started, rescheduling included.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

function gatewayConfig(coreBaseUrl: string): GatewayConfig {
  return {
    allowedOrigins: ["127.0.0.1"],
    authFailureLimiter: new RateLimiter(20, 60_000),
    coreBaseUrl: coreBaseUrl,
    limits: {
      maxConnections: 10,
      maxPayloadBytes: 1024 * 1024,
      backpressureBytes: 1024 * 1024,
      idleTimeoutSeconds: 255,
      runStartTimeoutMs: 5_000,
    },
    spentTickets: {
      spend: async function (): Promise<boolean> {
        return false;
      },
      release: async function (): Promise<void> {},
    },
    terminalTicketSecrets: [SECRET],
  };
}

function nextMessage(socket: WebSocket): Promise<ObservabilityServerMessage> {
  return new Promise((resolve, reject): void => {
    const timer = setTimeout((): void => reject(new Error("no frame")), 3_000);
    socket.addEventListener(
      "message",
      (event): void => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as ObservabilityServerMessage);
      },
      { once: true },
    );
  });
}

function openedSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject): void => {
    const timer = setTimeout(
      (): void => reject(new Error("no upgrade")),
      3_000,
    );
    socket.addEventListener(
      "open",
      (): void => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      (): void => {
        clearTimeout(timer);
        reject(new Error("upgrade refused"));
      },
      { once: true },
    );
  });
}

function tracePayload(traceId: string, ticket: StageSessionTicket): object {
  return {
    batches: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceId,
                spanId: "00f067aa0ba902b7",
                name: "agent.task",
                startTimeUnixNano: String(Date.now() * 1_000_000),
                attributes: [
                  {
                    key: "account_id",
                    value: {
                      stringValue:
                        traceId === OWN_TRACE_ID
                          ? ticket.accountId
                          : "other-account",
                    },
                  },
                  {
                    key: "project",
                    value: { stringValue: ticket.projectSlug },
                  },
                  { key: "stage", value: { stringValue: ticket.stageSlug } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
