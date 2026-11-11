import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { constants, inflateRawSync } from "node:zlib";
import type {
  ObservabilityServerMessage,
  ObservabilitySpanRow,
} from "../../../packages/broods/src/observability-contracts.ts";
import type { NatsConnection } from "../../core/src/shared/nats.ts";
import {
  createGateway,
  type GatewayConfig,
  type GatewayData,
} from "../src/main.ts";
import { resetTempoTraceCacheForTests } from "../src/observability.ts";
import { RateLimiter } from "../src/rate-limiter.ts";

// Bytes read off the TCP socket after the 101, for what an open dashboard asks of the gateway.
// Uncompressed they were 7,173,963 / 69,638 / 176,675 / 82,287, and a reconnect the list again.
// A ceiling sits about 15% over its measurement: raise one only with the number that explains it.
const LIST_WIRE_BYTES_MAX = 1_800_000;
const TRACE_WIRE_BYTES_MAX = 18_000;
const LOGS_WIRE_BYTES_MAX = 27_000;
const CHAT_WIRE_BYTES_MAX = 75_000;
const RECONNECT_WIRE_BYTES_MAX = 200;

const ACCOUNT_ID = "acct-transfer";
const PROJECT = "shop";
const STAGE = "dev";
const ENDPOINT_ID = "endpoint-transfer";
const TOKEN = "bdts_transfer";
const TRACE_COUNT = 100;
const STEPS_PER_TRACE = 4;
const TOOLS_PER_STEP = 2;
const REPLAY_TRACES = 3;
const LOG_COUNT = 200;
const CHAT_DELTAS = 400;
const OBSERVABILITY_PATH = `/v1/projects/${PROJECT}/stages/${STAGE}/observability/ws`;
const AGENT_PATH = `/v1/projects/${PROJECT}/stages/${STAGE}/agents/${ENDPOINT_ID}/ws`;
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const WORDS =
  "the agent reads file src index ts and returns error status ok for request user order invoice total customer shipping address payment refund pending completed failed retry timeout connection database query select from where limit update set value null true false function const return await async import export default type interface string number boolean array object map filter reduce json parse stringify response headers content authorization bearer token session message conversation tool call result output input step model reasoning because therefore next first then finally check verify confirm summary details".split(
    " ",
  );

type WireMessage = { opcode: number; text: string };
type WireClient = {
  close: () => void;
  extensions: string;
  next: () => Promise<WireMessage>;
  send: (message: object) => void;
  wireBytes: () => number;
};
type StoredMessage = { seq: number; subject: string; data: Uint8Array };
type ConsumerOptions = {
  filterSubjects?: string;
  opt_start_seq?: number;
  opt_start_time?: string;
};

const traces = fixtureTraces();
const logs = fixtureLogs();
const natsMessages = fixtureNatsMessages();
let upstream: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof Bun.serve<GatewayData>>;
let gateway: ReturnType<typeof createGateway>;
const savedEnv = {
  DEPLOYMENT_ENVIRONMENT: process.env.DEPLOYMENT_ENVIRONMENT,
  LOKI_URL: process.env.LOKI_URL,
  TEMPO_URL: process.env.TEMPO_URL,
};

beforeAll((): void => {
  resetTempoTraceCacheForTests();
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: upstreamFetch,
  });
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
  process.env.DEPLOYMENT_ENVIRONMENT = "test";
  process.env.TEMPO_URL = upstreamUrl;
  process.env.LOKI_URL = upstreamUrl;
  gateway = createGateway(gatewayConfig(upstreamUrl));
  server = Bun.serve<GatewayData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: gateway.fetch,
    websocket: gateway.websocket,
  });
});

afterAll(async (): Promise<void> => {
  gateway.closeSockets(1000, "test complete");
  await server.stop(true);
  await upstream.stop(true);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("the trace list backfill stays under its byte ceiling", async (): Promise<void> => {
  const client = await wireClient(OBSERVABILITY_PATH);
  try {
    client.send({ type: "subscribe", stream: "traces", backfill: TRACE_COUNT });
    const rows = await readBackfill(client);

    expect(client.extensions).toContain("permessage-deflate");
    expect(rows.length).toBe(
      traces.reduce((total, trace) => total + trace.length, 0) +
        REPLAY_TRACES * traces[0].length,
    );
    report("trace list, 100 traces", client.wireBytes(), rows);
    expect(client.wireBytes()).toBeLessThan(LIST_WIRE_BYTES_MAX);
  } finally {
    client.close();
  }
});

test("opening one trace stays under its byte ceiling", async (): Promise<void> => {
  const client = await wireClient(OBSERVABILITY_PATH);
  try {
    client.send({ type: "fetchTrace", traceId: traces[0][0].traceId });
    const rows = await readBackfill(client);

    expect(rows.length).toBe(traces[0].length);
    report("one trace by id", client.wireBytes(), rows);
    expect(client.wireBytes()).toBeLessThan(TRACE_WIRE_BYTES_MAX);
  } finally {
    client.close();
  }
});

test("a logs backfill stays under its byte ceiling", async (): Promise<void> => {
  const client = await wireClient(OBSERVABILITY_PATH);
  try {
    client.send({
      type: "subscribe",
      stream: "logs",
      backfill: LOG_COUNT,
      historyOnly: true,
    });
    const rows = await readBackfill(client);

    expect(rows.length).toBe(LOG_COUNT);
    report("logs backfill, 200 lines", client.wireBytes(), rows);
    expect(client.wireBytes()).toBeLessThan(LOGS_WIRE_BYTES_MAX);
  } finally {
    client.close();
  }
});

test("a streamed chat answer stays under its byte ceiling", async (): Promise<void> => {
  const client = await wireClient(AGENT_PATH);
  try {
    client.send({
      type: "attach",
      requestId: "attach-1",
      agentId: "agent-1",
      conversationKey: "chat-1",
      eventId: "event-1",
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const frames: unknown[] = [];
    for (;;) {
      const frame = JSON.parse((await client.next()).text) as {
        type: string;
        data?: { type?: string };
      };
      frames.push(frame);
      if (frame.type === "error") throw new Error(JSON.stringify(frame));
      if (frame.data?.type === "done") break;
    }

    expect(frames.length).toBeGreaterThan(CHAT_DELTAS);
    report("chat answer, 400 deltas", client.wireBytes(), frames);
    expect(client.wireBytes()).toBeLessThan(CHAT_WIRE_BYTES_MAX);
  } finally {
    client.close();
  }
});

test("a reconnect resumes from the last cursor instead of replaying", async (): Promise<void> => {
  const first = await wireClient(OBSERVABILITY_PATH);
  let cursor = 0;
  try {
    first.send({ type: "subscribe", stream: "traces", backfill: TRACE_COUNT });
    for (;;) {
      const message = JSON.parse(
        (await first.next()).text,
      ) as ObservabilityServerMessage;
      if (message.type === "span") cursor = message.seq ?? cursor;
      if (message.type === "backfill" && !message.more) break;
    }
  } finally {
    first.close();
  }
  expect(cursor).toBe(natsMessages.length);

  const second = await wireClient(OBSERVABILITY_PATH);
  try {
    second.send({ type: "subscribe", stream: "traces", afterSeq: cursor });
    expect(JSON.parse((await second.next()).text)).toEqual({
      type: "ready",
      seq: cursor,
    });
    await Bun.sleep(100);

    report("reconnect, nothing new", second.wireBytes(), []);
    expect(second.wireBytes()).toBeLessThan(RECONNECT_WIRE_BYTES_MAX);
  } finally {
    second.close();
  }
});

async function readBackfill(client: WireClient): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (;;) {
    const message = JSON.parse(
      (await client.next()).text,
    ) as ObservabilityServerMessage;
    if (message.type === "error") throw new Error(message.error);
    if (message.type === "span") rows.push(message.entry);
    if (message.type !== "backfill") continue;
    if (message.error) throw new Error(message.error);
    rows.push(...message.entries);
    if (!message.more) return rows;
  }
}

function report(path: string, wireBytes: number, rows: unknown[]): void {
  const jsonBytes = Buffer.byteLength(JSON.stringify(rows));
  console.log(
    `socket-transfer | ${path} | wire ${wireBytes} B | rows as JSON ${jsonBytes} B`,
  );
}

// A browser's handshake, by hand: the WebSocket API hides both the extension and the bytes.
function wireClient(path: string): Promise<WireClient> {
  return new Promise((resolve, reject): void => {
    const socket: Socket = connect(server.port ?? 0, "127.0.0.1");
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    let wireBytes = 0;
    let fragments: Buffer[] = [];
    let compressed = false;
    const ready: WireMessage[] = [];
    let wake: (() => void) | null = null;

    const deliver = (
      opcode: number,
      payload: Buffer,
      deflated: boolean,
    ): void => {
      const body = deflated
        ? inflateRawSync(Buffer.concat([payload, DEFLATE_TAIL]), {
            finishFlush: constants.Z_SYNC_FLUSH,
          })
        : payload;
      ready.push({ opcode: opcode, text: body.toString("utf8") });
      wake?.();
      wake = null;
    };
    const readFrames = (): void => {
      for (;;) {
        if (buffered.length < 2) return;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffered.length < offset + length) return;
        const opcode = buffered[0] & 0x0f;
        const payload = buffered.subarray(offset, offset + length);
        if (opcode !== 0) compressed = (buffered[0] & 0x40) !== 0;
        const final = (buffered[0] & 0x80) !== 0;
        buffered = buffered.subarray(offset + length);
        if (opcode >= 8) continue;
        fragments.push(payload);
        if (!final) continue;
        deliver(opcode, Buffer.concat(fragments), compressed);
        fragments = [];
      }
    };

    socket.on("error", reject);
    socket.on("data", (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffered.subarray(0, end).toString("latin1");
        buffered = buffered.subarray(end + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          reject(new Error(head));

          return;
        }
        upgraded = true;
        wireBytes = buffered.length;
        resolve({
          close: (): void => void socket.destroy(),
          extensions:
            /^sec-websocket-extensions: (.*)$/im.exec(head)?.[1] ?? "",
          next: async (): Promise<WireMessage> => {
            const deadline = Date.now() + 10_000;
            while (ready.length === 0) {
              if (Date.now() > deadline) throw new Error("no frame");
              await Promise.race([
                new Promise<void>((woken): void => {
                  wake = woken;
                }),
                Bun.sleep(250),
              ]);
            }

            return ready.shift()!;
          },
          send: (message: object): void => {
            const body = Buffer.from(JSON.stringify(message));
            const head =
              body.length < 126
                ? Buffer.from([0x81, 0x80 | body.length])
                : Buffer.from([
                    0x81,
                    0xfe,
                    body.length >> 8,
                    body.length & 255,
                  ]);
            socket.write(Buffer.concat([head, Buffer.alloc(4), body]));
          },
          wireBytes: (): number => wireBytes,
        });
      } else {
        wireBytes += chunk.length;
      }
      readFrames();
    });
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${btoa("socket-transfer!")}`,
        `Sec-WebSocket-Protocol: broods.v1, broods.token.${TOKEN}`,
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
        "",
        "",
      ].join("\r\n"),
    );
  });
}

async function upstreamFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/internal/")) {
    return Response.json({
      accountId: ACCOUNT_ID,
      projectSlug: PROJECT,
      stageSlug: STAGE,
      endpointIds: [ENDPOINT_ID],
      expiresAt: Date.now() + 60 * 60_000,
    });
  }
  if (url.pathname === "/api/search") {
    return Response.json({
      traces: traces.map((trace) => ({
        traceID: trace[0].traceId,
        startTimeUnixNano: `${trace[0].startTimeMs}000000`,
      })),
    });
  }
  if (url.pathname.startsWith("/api/traces/")) {
    const trace = traces.find(
      (candidate) => candidate[0].traceId === url.pathname.split("/").at(-1),
    );

    return trace
      ? Response.json(tempoTrace(trace))
      : new Response(null, { status: 404 });
  }
  if (url.pathname === "/loki/api/v1/query_range") {
    return Response.json({
      data: {
        result: [
          {
            stream: { service_name: "broods-core" },
            values: logs.map((line, index) => [
              `${(Date.now() - index * 1_000) * 1_000_000}`,
              line,
            ]),
          },
        ],
      },
    });
  }
  // The attach's status read: the run is still streaming.
  if (url.pathname.startsWith("/v1/")) {
    return Response.json({
      eventId: "event-1",
      agentId: "agent-1",
      conversationKey: "chat-1",
      status: "processing",
    });
  }

  return new Response(null, { status: 404 });
}

function gatewayConfig(coreBaseUrl: string): GatewayConfig {
  return {
    allowedOrigins: ["127.0.0.1"],
    authFailureLimiter: new RateLimiter(20, 60_000),
    coreBaseUrl: coreBaseUrl,
    limits: {
      maxConnections: 10,
      maxPayloadBytes: 1024 * 1024,
      backpressureBytes: 16 * 1024 * 1024,
      idleTimeoutSeconds: 255,
      runStartTimeoutMs: 5_000,
    },
    natsConnection: async (): Promise<NatsConnection> =>
      fakeNats() as unknown as NatsConnection,
    spentTickets: {
      spend: async function (): Promise<boolean> {
        return false;
      },
      release: async function (): Promise<void> {},
    },
    terminalTicketSecrets: ["socket-transfer-secret"],
  };
}

// JetStream as the gateway uses it: a filtered consumer started by time or by sequence.
function fakeNats(): object {
  const streams = {
    add: async (): Promise<void> => {},
    getMessage: async (): Promise<{ seq: number }> => ({
      seq: CHAT_DELTAS + 1,
    }),
    info: async (
      _name: string,
      options?: { subjects_filter?: string },
    ): Promise<object> => ({
      created: "2026-07-24T00:00:00.000Z",
      state: {
        first_seq: 1,
        last_seq: natsMessages.length,
        subjects: options?.subjects_filter
          ? { [options.subjects_filter]: CHAT_DELTAS + 1 }
          : {},
      },
    }),
    update: async (): Promise<void> => {},
  };

  return {
    jetstreamManager: async (): Promise<object> => ({ streams: streams }),
    jetstream: (): object => ({
      consumers: {
        get: async (
          _stream: string,
          options: ConsumerOptions,
        ): Promise<object> => ({
          info: async (): Promise<object> => ({
            delivered: { stream_seq: (options.opt_start_seq ?? 1) - 1 },
          }),
          consume: async (): Promise<object> => {
            let stopped = false;
            const wanted = natsMessages.filter(
              (message) =>
                message.seq >= (options.opt_start_seq ?? 0) &&
                subjectKind(message.subject) ===
                  subjectKind(options.filterSubjects ?? ""),
            );

            return {
              [Symbol.asyncIterator]:
                async function* (): AsyncGenerator<StoredMessage> {
                  for (const message of wanted) yield message;
                  while (!stopped) await Bun.sleep(20);
                },
              close: async (): Promise<void> => {
                stopped = true;
              },
              stop: (): void => {
                stopped = true;
              },
            };
          },
        }),
      },
    }),
  };
}

function subjectKind(subject: string): string {
  return subject.includes("traces")
    ? "traces"
    : subject.includes("logs")
      ? "logs"
      : "chat";
}

function fixtureNatsMessages(): StoredMessage[] {
  const encoder = new TextEncoder();
  const random = seeded(7);
  const spans = traces
    .slice(0, REPLAY_TRACES)
    .flat()
    .map((row): StoredMessage => ({
      seq: 0,
      subject: "obs.traces",
      data: encoder.encode(JSON.stringify(row)),
    }));
  const deltas = Array.from({ length: CHAT_DELTAS + 1 }, (_, index) => ({
    seq: 0,
    subject: "ws.chat",
    data: encoder.encode(
      JSON.stringify({
        type: "stream",
        headers: {
          accountId: ACCOUNT_ID,
          agentId: "agent-1",
          conversationKey: "chat-1",
          eventId: "event-1",
          connectionId: "event-1",
        },
        data:
          index === CHAT_DELTAS
            ? { type: "done" }
            : { type: "text-delta", id: "0", text: prose(random, 24) },
        sequence: index + 1,
      }),
    ),
  }));

  return [...deltas, ...spans].map((message, index) => ({
    ...message,
    seq: index + 1,
  }));
}

function fixtureLogs(): string[] {
  const random = seeded(3);

  return Array.from({ length: LOG_COUNT }, (_, index) =>
    JSON.stringify({
      level: index % 9 === 0 ? "WARN" : "INFO",
      ts: 1_760_000_000_000 + index * 1_000,
      logId: hex(random, 16),
      eventType: "agent.step",
      message: prose(random, 160),
      traceId: hex(random, 32),
      accountId: ACCOUNT_ID,
      endpointId: ENDPOINT_ID,
      agentId: "agent-1",
      conversationKey: `chat-${index % 7}`,
      service: "broods-core",
    }),
  );
}

// One run as core records it: a root with the model input, steps with their answers, tool calls.
function fixtureTraces(): ObservabilitySpanRow[][] {
  const random = seeded(1);
  const scope = { account_id: ACCOUNT_ID, project: PROJECT, stage: STAGE };

  return Array.from({ length: TRACE_COUNT }, (_, index) => {
    const traceId = hex(random, 32);
    const startTimeMs = 1_760_000_000_000 - index * 60_000;
    const shared = {
      traceId: traceId,
      status: "ok" as const,
      endpointId: ENDPOINT_ID,
      agentId: "agent-1",
      conversationKey: `chat-${index}`,
    };
    const rootSpanId = hex(random, 16);
    const root: ObservabilitySpanRow = {
      ...shared,
      spanId: rootSpanId,
      name: "agent.task",
      kind: "task",
      startTimeMs: startTimeMs,
      endTimeMs: startTimeMs + 40_000,
      durationMs: 40_000,
      attributes: {
        ...scope,
        "task.id": hex(random, 24),
        "task.state": "completed",
        "task.delivery": "direct",
        "task.input": prose(random, 200),
        "agent.environment": prose(random, 400),
        "agent.message_count": 12,
        "model.provider": "anthropic",
        "model.id": "claude-haiku-5-5",
        "model.input": prose(random, 6_000),
        "model.system": prose(random, 2_000),
      },
    };
    const children = Array.from({ length: STEPS_PER_TRACE }, (_, step) => {
      const stepSpanId = hex(random, 16);
      const stepStart = startTimeMs + step * 10_000;
      const tools = Array.from(
        { length: TOOLS_PER_STEP },
        (_, tool): ObservabilitySpanRow => ({
          ...shared,
          spanId: hex(random, 16),
          parentSpanId: stepSpanId,
          name: "tool.call",
          kind: "tool.call",
          startTimeMs: stepStart + 2_000 + tool * 3_000,
          endTimeMs: stepStart + 4_000 + tool * 3_000,
          durationMs: 2_000,
          attributes: {
            ...scope,
            "tool.name": tool === 0 ? "bash" : "read",
            "tool.call_id": `toolu_${hex(random, 24)}`,
            "tool.state": "completed",
            "tool.input": prose(random, 300),
            "tool.output": prose(random, 2_500),
            "agent.step_number": step,
          },
        }),
      );
      const stepSpan: ObservabilitySpanRow = {
        ...shared,
        spanId: stepSpanId,
        parentSpanId: rootSpanId,
        name: "model.step",
        kind: "model.step",
        startTimeMs: stepStart,
        endTimeMs: stepStart + 9_000,
        durationMs: 9_000,
        attributes: {
          ...scope,
          "agent.step_number": step,
          "step.state": "completed",
          "model.finish_reason": "tool-calls",
          "agent.tool_call_count": TOOLS_PER_STEP,
          "model.input_tokens": 4_000 + step * 900,
          "model.output_tokens": 350,
          "model.reasoning_tokens": 120,
          "model.cached_input_tokens": 3_200,
          "model.cache_write_tokens": 0,
          "model.total_tokens": 4_350 + step * 900,
          "model.response": prose(random, 1_200),
          "model.reasoning": prose(random, 600),
          "model.tool_calls": tools
            .map((tool) => String(tool.attributes?.["tool.input"]))
            .join(" "),
          "model.tool_results": tools
            .map((tool) => String(tool.attributes?.["tool.output"]))
            .join(" "),
        },
      };

      return [stepSpan, ...tools];
    });

    return [root, ...children.flat()];
  });
}

function tempoTrace(rows: ObservabilitySpanRow[]): object {
  return {
    batches: [
      {
        scopeSpans: [
          {
            spans: rows.map((row) => ({
              traceId: row.traceId,
              spanId: row.spanId,
              parentSpanId: row.parentSpanId,
              name: row.name,
              startTimeUnixNano: `${row.startTimeMs}000000`,
              endTimeUnixNano: `${row.endTimeMs}000000`,
              attributes: Object.entries({
                ...row.attributes,
                endpoint_id: row.endpointId,
                agent_id: row.agentId,
                conversation_key: row.conversationKey,
              }).map(([key, value]) => ({
                key: key,
                value:
                  typeof value === "number"
                    ? { intValue: value }
                    : { stringValue: value },
              })),
            })),
          },
        ],
      },
    ],
  };
}

// Words with an id every few, so deflate meets text about as repetitive as a real transcript.
function prose(random: () => number, chars: number): string {
  let text = "";
  while (text.length < chars) {
    text +=
      random() < 0.15
        ? `${hex(random, 8)} `
        : `${WORDS[Math.floor(random() * WORDS.length)]} `;
  }

  return text.slice(0, chars);
}

function hex(random: () => number, length: number): string {
  let value = "";
  while (value.length < length) value += Math.floor(random() * 16).toString(16);

  return value;
}

function seeded(seed: number): () => number {
  let state = seed;

  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
