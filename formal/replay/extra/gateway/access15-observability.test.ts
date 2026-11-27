import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { NatsConnection } from "nats.ws";

import {
  cleanupObservabilitySocket,
  fetchTempoBackfill,
  handleObservabilityMessage,
  openObservabilitySocket,
  relayNatsMessages,
  resetTempoTraceCacheForTests,
  tempoTraceRowsFromResponse,
  watchObservabilityLifetime,
  type ObservabilityGatewayData,
} from "../../../../apps/gateway/src/observability.ts";

type ObsSocket = Bun.ServerWebSocket<ObservabilityGatewayData>;

interface FakeObsSocket {
  socket: ObsSocket;
  sent: Array<Record<string, unknown>>;
  closes: number[];
  state: { readyState: number };
  buffer: { buffered: number };
}

const SANDBOX_ID = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const NS_PER_MS = 1_000_000n;
const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

function fakeSocket(expiresAt = Number.MAX_SAFE_INTEGER): FakeObsSocket {
  const sent: Array<Record<string, unknown>> = [];
  const closes: number[] = [];
  const buffer = { buffered: 0 };
  const socket = {
    readyState: WebSocket.OPEN as number,
    getBufferedAmount: (): number => buffer.buffered,
    send: (value: string): number =>
      sent.push(JSON.parse(value) as Record<string, unknown>),
    close: (code: number): void => {
      closes.push(code);
    },
    data: {
      kind: "observability",
      scope: {
        accountId: "acct-1",
        projectSlug: "shop",
        stageSlug: "dev",
        endpointIds: [],
        expiresAt: expiresAt,
      },
      token: "bdts_fixture",
    },
  } as unknown as ObsSocket;

  return {
    socket: socket,
    sent: sent,
    closes: closes,
    state: socket as unknown as { readyState: number },
    buffer: buffer,
  };
}

function subscribeSandbox(
  fake: FakeObsSocket,
  backfill: number,
): Promise<void> {
  return handleObservabilityMessage(
    fake.socket,
    JSON.stringify({
      type: "subscribe",
      stream: "logs",
      backfill: backfill,
      sandboxId: SANDBOX_ID,
    }),
    async (): Promise<NatsConnection> => {
      throw new Error("sandbox tails never reach NATS");
    },
  );
}

function lokiAnswer(rows: Array<[string, string]>): Response {
  return Response.json({ data: { result: [{ stream: {}, values: rows }] } });
}

function nsAgo(ms: number): string {
  return String((BigInt(Date.now()) - BigInt(ms)) * NS_PER_MS);
}

function natsMessages(payloads: unknown[]): {
  [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }>;
} {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<{
      data: Uint8Array;
    }> {
      for (const payload of payloads) {
        yield { data: encoder.encode(JSON.stringify(payload)) };
      }
    },
  };
}

afterEach((): void => {
  globalThis.fetch = realFetch;
  delete process.env["LOKI_URL"];
  resetTempoTraceCacheForTests();
});

describe("tempoTraceRowsFromResponse", (): void => {
  test("reads every attribute type and span kind", (): void => {
    const rows = tempoTraceRowsFromResponse({
      batches: [
        {
          resource: {
            attributes: [{ key: "attempts", value: { intValue: "7" } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "trace-1",
                  spanId: "model-1",
                  name: "model.step",
                  attributes: [
                    { key: "ratio", value: { doubleValue: 0.5 } },
                    { key: "cached", value: { boolValue: true } },
                    {
                      key: "tags",
                      value: {
                        arrayValue: {
                          values: [{ stringValue: "a" }, { intValue: 2 }],
                        },
                      },
                    },
                    { key: "empty", value: {} },
                  ],
                },
                { traceId: "trace-1", spanId: "sub-1", name: "agent.subtask" },
                { traceId: "trace-1", spanId: "cron-1", name: "agent.cron" },
                { traceId: "trace-1", name: "agent.task" },
              ],
            },
          ],
        },
      ],
    });

    expect(rows.map((row): string => `${row.spanId}:${row.kind}`)).toEqual([
      "model-1:model.step",
      "sub-1:subtask",
      "cron-1:cron",
    ]);
    expect(rows[0]?.attributes).toEqual({
      attempts: 7,
      ratio: 0.5,
      cached: true,
      tags: ["a", 2],
      empty: undefined,
    });
  });
});

describe("fetchTempoBackfill", (): void => {
  test("yields no rows for a trace Tempo no longer has", async (): Promise<void> => {
    globalThis.fetch = (async (url: string | URL): Promise<Response> =>
      String(url).includes("/api/search")
        ? Response.json({ traces: [{ traceID: "gone" }] })
        : new Response(null, { status: 404 })) as unknown as typeof fetch;
    const chunks = [];
    for await (const chunk of fetchTempoBackfill(
      "http://tempo.example",
      { accountId: "acct-1", projectSlug: "shop", stageSlug: "dev" } as never,
      5,
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ rows: [], failures: 0 }]);
  });
});

describe("relayNatsMessages", (): void => {
  test("drops a log whose level is unknown", async (): Promise<void> => {
    const fake = fakeSocket();
    await relayNatsMessages(
      fake.socket,
      natsMessages([
        { level: "LOUD", message: "x" },
        { level: "ERROR", message: "y" },
      ]),
      "logs",
      { logsMinLevel: "INFO" },
    );

    expect(fake.sent.map((frame): unknown => frame.type)).toEqual(["log"]);
  });

  test("sheds a log while the tab is backed up", async (): Promise<void> => {
    const fake = fakeSocket();
    fake.buffer.buffered = 1024 * 1024;
    await relayNatsMessages(
      fake.socket,
      natsMessages([{ level: "ERROR", message: "y" }]),
      "logs",
      { logsMinLevel: "INFO" },
    );

    expect(fake.sent).toEqual([]);
  });

  test("sends nothing to a closed socket", async (): Promise<void> => {
    const fake = fakeSocket();
    fake.state.readyState = WebSocket.CLOSED;
    await relayNatsMessages(
      fake.socket,
      natsMessages([{ level: "ERROR", message: "y" }]),
      "logs",
      { logsMinLevel: "INFO" },
    );

    expect(fake.sent).toEqual([]);
  });
});

describe("observability socket lifetime", (): void => {
  test("a socket that was never opened arms no timer", (): void => {
    const fake = fakeSocket();
    const timers = spyOn(globalThis, "setTimeout");
    watchObservabilityLifetime(fake.socket, "http://core.example");
    const armed = timers.mock.calls.length;
    timers.mockRestore();

    expect(armed).toBe(0);
  });

  test("closes a socket core no longer recognises", async (): Promise<void> => {
    const fake = fakeSocket();
    openObservabilitySocket(fake.socket);
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const timers = spyOn(globalThis, "setTimeout");
    watchObservabilityLifetime(fake.socket, "http://core.example");
    const callback = timers.mock.calls[0]?.[0] as () => Promise<void>;
    timers.mockRestore();
    await callback();

    expect(fake.closes).toEqual([4401]);
    cleanupObservabilitySocket(fake.socket);
  });

  test("an unopened socket ignores an unsubscribe", async (): Promise<void> => {
    const fake = fakeSocket();
    await handleObservabilityMessage(
      fake.socket,
      JSON.stringify({ type: "unsubscribe", stream: "logs" }),
      async (): Promise<NatsConnection> => {
        throw new Error("unused");
      },
    );

    expect(fake.sent).toEqual([]);
  });
});

describe("startSandboxLogPoll", (): void => {
  test("is unavailable without a Loki URL", async (): Promise<void> => {
    const fake = fakeSocket();
    openObservabilitySocket(fake.socket);
    await subscribeSandbox(fake, 0);

    expect(fake.sent).toEqual([
      { type: "error", error: "Live observability transport is unavailable." },
    ]);
    cleanupObservabilitySocket(fake.socket);
  });

  test("backfills once, then sends only lines it has not seen", async (): Promise<void> => {
    process.env["LOKI_URL"] = "http://loki.example";
    const old: [string, string] = ["1000000000", "ancient"];
    const first: [string, string] = [nsAgo(5_000), "first"];
    const second: [string, string] = [nsAgo(4_000), "second"];
    const third: [string, string] = [nsAgo(100), "third"];
    const answers = [
      lokiAnswer([old, first, second]),
      lokiAnswer([first, second, third]),
    ];
    globalThis.fetch = (async (): Promise<Response> =>
      answers.shift() ?? lokiAnswer([])) as unknown as typeof fetch;
    const fake = fakeSocket();
    openObservabilitySocket(fake.socket);
    await subscribeSandbox(fake, 5);
    for (let waited = 0; waited < 4_000 && answers.length > 0; waited += 20) {
      await Bun.sleep(20);
    }
    await Bun.sleep(50);
    cleanupObservabilitySocket(fake.socket);

    const backfill = fake.sent.find(
      (frame): boolean => frame.type === "backfill",
    );
    expect(
      (backfill?.entries as Array<{ message: string }>).map(
        (entry): string => entry.message,
      ),
    ).toEqual(["second", "first", "ancient"]);
    expect(
      fake.sent
        .filter((frame): boolean => frame.type === "log")
        .map((frame): unknown => (frame.entry as { message: string }).message),
    ).toEqual(["third"]);
  }, 10_000);

  test("reports a failed poll and keeps the tail", async (): Promise<void> => {
    process.env["LOKI_URL"] = "http://loki.example";
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls += 1;
      throw new Error("loki down");
    }) as unknown as typeof fetch;
    const errors = spyOn(console, "error").mockImplementation((): void => {});
    const fake = fakeSocket();
    openObservabilitySocket(fake.socket);
    await subscribeSandbox(fake, 0);
    for (let waited = 0; waited < 4_000 && calls === 0; waited += 20) {
      await Bun.sleep(20);
    }
    await Bun.sleep(20);
    cleanupObservabilitySocket(fake.socket);
    const messages = errors.mock.calls.map((call): unknown => call[0]);
    errors.mockRestore();

    expect(messages).toEqual(["observability sandbox log poll failed:"]);
  }, 10_000);

  test("skips a poll while the socket is closed", async (): Promise<void> => {
    process.env["LOKI_URL"] = "http://loki.example";
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls += 1;

      return lokiAnswer([]);
    }) as unknown as typeof fetch;
    const fake = fakeSocket();
    openObservabilitySocket(fake.socket);
    await subscribeSandbox(fake, 0);
    fake.state.readyState = WebSocket.CLOSED;
    await Bun.sleep(2_300);
    cleanupObservabilitySocket(fake.socket);

    expect(calls).toBe(0);
  }, 10_000);

  test.each([
    ["a backfill that lands", false],
    ["a backfill that fails", true],
  ])(
    "drops %s after the tab unsubscribed",
    async (_name: string, fails: boolean): Promise<void> => {
      process.env["LOKI_URL"] = "http://loki.example";
      let release = (): void => {};
      const held = new Promise<void>((resolve): void => {
        release = resolve;
      });
      globalThis.fetch = (async (): Promise<Response> => {
        await held;
        if (fails) throw new Error("loki down");

        return lokiAnswer([[nsAgo(100), "late"]]);
      }) as unknown as typeof fetch;
      const errors = spyOn(console, "error").mockImplementation((): void => {});
      const fake = fakeSocket();
      openObservabilitySocket(fake.socket);
      await subscribeSandbox(fake, 5);
      cleanupObservabilitySocket(fake.socket);
      release();
      await Bun.sleep(50);
      errors.mockRestore();

      expect(fake.sent).toEqual([{ type: "ready" }]);
    },
  );
});
