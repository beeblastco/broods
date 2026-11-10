import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NatsConnection } from "nats.ws";

import { streamResponseSubject } from "../../../../apps/core/src/shared/nats.ts";
import {
  handleAgentMessage,
  type AgentTestGatewayData,
} from "../../../../apps/gateway/src/agent.ts";
import type { GatewayLimits } from "../../../../apps/gateway/src/utils.ts";

// The gateway keys a cursor by the attach's event id: the first 16 base64url chars of its sha256.
const EVENT_KEY = createHash("sha256")
  .update("event")
  .digest("base64url")
  .slice(0, 16);

type AgentSocket = Bun.ServerWebSocket<AgentTestGatewayData>;
type Frame = Record<string, unknown>;

interface FakeStream {
  lastSequence: number;
  bufferedCount: number;
  lastBySubject: () => number | null;
  retainedSubject: string | null;
  consume: () => Promise<FakeConsumer>;
  infoGate?: Promise<void>;
  infoLastSequences?: number[];
}

interface FakeMessage {
  seq: number;
  data: Uint8Array;
  ack: () => void;
}

interface FakeConsumer {
  [Symbol.asyncIterator]: () => AsyncIterator<FakeMessage>;
  close: () => Promise<void>;
}

const CREATED = "2026-01-01T00:00:00.000Z";
const GENERATION = Buffer.from(CREATED, "utf8").toString("base64url");
const SUBJECT = streamResponseSubject("acct_1", "agent_1", "conversation");
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const sockets: AgentSocket[] = [];

function limits(timeoutMs: number): GatewayLimits {
  return { runStartTimeoutMs: timeoutMs } as unknown as GatewayLimits;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "content-type": "application/json" },
  });
}

function makeSocket(): { socket: AgentSocket; frames: Frame[] } {
  const frames: Frame[] = [];
  const socket = {
    data: {
      kind: "agent-test",
      corePath: "/v1/agents/agent_1",
      token: "runtime-key",
      coreBaseUrl: "https://core.example",
      accountId: "acct_1",
    },
    send: (text: string): number => {
      frames.push(JSON.parse(text) as Frame);

      return text.length;
    },
    close: (): void => {},
  } as unknown as AgentSocket;
  sockets.push(socket);

  return { socket: socket, frames: frames };
}

function stream(overrides: Partial<FakeStream>): FakeStream {
  return {
    lastSequence: 20,
    bufferedCount: 0,
    lastBySubject: (): number | null => null,
    retainedSubject: null,
    consume: async (): Promise<FakeConsumer> => idleConsumer(),
    ...overrides,
  };
}

function connection(fake: FakeStream): NatsConnection {
  let infoCalls = 0;

  return {
    jetstreamManager: async (): Promise<unknown> => ({
      streams: {
        add: async (): Promise<void> => {},
        update: async (): Promise<void> => {},
        getMessage: async (
          _name: string,
          query: { last_by_subj?: string; seq?: number },
        ): Promise<{ seq: number; subject: string }> => {
          if (query.last_by_subj !== undefined) {
            const seq = fake.lastBySubject();
            if (seq === null) throw new Error("no message");

            return { seq: seq, subject: SUBJECT };
          }
          if (fake.retainedSubject === null) throw new Error("evicted");

          return { seq: query.seq ?? 0, subject: fake.retainedSubject };
        },
        info: async (
          _name: string,
          options?: { subjects_filter?: string },
        ): Promise<unknown> => {
          if (options !== undefined) await fake.infoGate;
          const sequences = fake.infoLastSequences;
          const lastSeq =
            sequences === undefined || options === undefined
              ? fake.lastSequence
              : (sequences[Math.min(infoCalls++, sequences.length - 1)] ??
                fake.lastSequence);

          return {
            created: CREATED,
            state: {
              last_seq: lastSeq,
              subjects:
                options?.subjects_filter === undefined
                  ? undefined
                  : { [options.subjects_filter]: fake.bufferedCount },
            },
          };
        },
      },
    }),
    jetstream: (): unknown => ({
      consumers: {
        get: async (): Promise<unknown> => ({ consume: fake.consume }),
      },
    }),
  } as unknown as NatsConnection;
}

function idleConsumer(): FakeConsumer {
  let release = (): void => {};
  const closed = new Promise<void>((resolve): void => {
    release = resolve;
  });

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<FakeMessage> => ({
      next: async (): Promise<IteratorResult<FakeMessage>> => {
        await closed;

        return { done: true, value: undefined };
      },
    }),
    close: async (): Promise<void> => release(),
  };
}

function messageConsumer(
  steps: Array<{ afterMs: number; message?: FakeMessage }>,
): FakeConsumer {
  const idle = idleConsumer();
  const queue = [...steps];

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<FakeMessage> => ({
      next: async (): Promise<IteratorResult<FakeMessage>> => {
        const step = queue.shift();
        if (!step) return idle[Symbol.asyncIterator]().next();
        await Bun.sleep(step.afterMs);
        if (!step.message) return { done: true, value: undefined };

        return { done: false, value: step.message };
      },
    }),
    close: idle.close,
  };
}

function streamMessage(
  seq: number,
  eventId: string,
  data: Frame,
  ack: () => void = (): void => {},
): FakeMessage {
  return {
    seq: seq,
    ack: ack,
    data: encoder.encode(
      JSON.stringify({
        type: "stream",
        headers: {
          accountId: "acct_1",
          agentId: "agent_1",
          conversationKey: "conversation",
          eventId: eventId,
          connectionId: eventId,
        },
        data: data,
        sequence: seq,
      }),
    ),
  };
}

function attach(
  socket: AgentSocket,
  nats: () => Promise<NatsConnection>,
  extra: Frame = {},
  timeoutMs = 5_000,
): void {
  handleAgentMessage(
    socket,
    JSON.stringify({
      type: "attach",
      requestId: "att",
      agentId: "agent_1",
      conversationKey: "conversation",
      eventId: "event",
      runId: "run_1",
      ...extra,
    }),
    limits(timeoutMs),
    nats,
  );
}

function execute(
  socket: AgentSocket,
  nats: () => Promise<NatsConnection>,
  timeoutMs = 5_000,
): void {
  handleAgentMessage(
    socket,
    JSON.stringify({
      type: "execute",
      agentId: "agent_1",
      eventId: "run-1",
      sessionId: "conversation",
      input: "hi",
    }),
    limits(timeoutMs),
    nats,
  );
}

async function until(done: () => boolean, budgetMs = 12_000): Promise<void> {
  for (let waited = 0; waited < budgetMs && !done(); waited += 10) {
    await Bun.sleep(10);
  }
  expect(done()).toBe(true);
}

function has(frames: Frame[], type: string): boolean {
  return frames.some((frame): boolean => frame.type === type);
}

function cancel(socket: AgentSocket): void {
  handleAgentMessage(
    socket,
    JSON.stringify({ type: "cancel" }),
    limits(5_000),
    async (): Promise<NatsConnection> => connection(stream({})),
  );
}

beforeEach((): void => {
  globalThis.fetch = (async (): Promise<Response> =>
    json(200, {
      agentId: "agent_1",
      conversationKey: "conversation",
      eventId: "event",
      status: "processing",
    })) as unknown as typeof fetch;
});

afterEach((): void => {
  for (const socket of sockets.splice(0)) cancel(socket);
  globalThis.fetch = originalFetch;
});

const UNAVAILABLE: Frame = {
  type: "replay_unavailable",
  requestId: "att",
  eventId: "event",
  status: "processing",
  statusUrl: "/v1/runs/run_1",
};

describe("attachCoreStream", (): void => {
  test.each([
    ["the subject has no retained message", null, null, 5],
    ["the cursor is past the last sequence", 25, SUBJECT, 30],
    ["the cursor message sits on another subject", 25, "v1.other.subject", 10],
  ])(
    "refuses a cursor when %s",
    async (
      _name: string,
      last: number | null,
      retained: string | null,
      sequence: number,
    ): Promise<void> => {
      const { socket, frames } = makeSocket();
      const fake = stream({
        lastBySubject: (): number | null => last,
        retainedSubject: retained,
      });
      attach(socket, async (): Promise<NatsConnection> => connection(fake), {
        afterCursor: `ws-responses:${GENERATION}:${sequence}:${EVENT_KEY}`,
      });
      await until((): boolean => frames.length > 0);

      expect(frames).toEqual([UNAVAILABLE]);
    },
  );

  test("resumes a retained cursor from the next sequence", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    const fake = stream({
      lastSequence: 25,
      bufferedCount: 3,
      lastBySubject: (): number | null => 25,
      retainedSubject: SUBJECT,
      consume: async (): Promise<FakeConsumer> =>
        messageConsumer([
          {
            afterMs: 0,
            message: streamMessage(11, "event", { type: "text-delta" }),
          },
          { afterMs: 0, message: streamMessage(12, "event", { type: "done" }) },
        ]),
    });
    attach(socket, async (): Promise<NatsConnection> => connection(fake), {
      afterCursor: `ws-responses:${GENERATION}:10:${EVENT_KEY}`,
    });
    await until((): boolean =>
      frames.some((frame): boolean => {
        const data = frame.data as { type?: string } | undefined;

        return data?.type === "done";
      }),
    );

    const attached = frames[0] as { replayFromCursor: string };
    expect(frames[0]?.type).toBe("attached");
    expect(
      attached.replayFromCursor.startsWith(`ws-responses:${GENERATION}:11:`),
    ).toBe(true);
    expect(
      frames
        .filter((frame): boolean => frame.type === "output")
        .map((frame): unknown => frame.replay),
    ).toEqual([true, true]);
  });

  test("reports an attach that outlives the start timeout", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    let release = (): void => {};
    const held = new Promise<NatsConnection>((resolve): void => {
      release = (): void => resolve(connection(stream({})));
    });
    attach(socket, (): Promise<NatsConnection> => held, {}, 30);
    await until((): boolean => has(frames, "error"));
    release();
    await Bun.sleep(30);

    expect(frames).toEqual([{ type: "error", error: "Attach timed out" }]);
  });

  test("stays silent when cancelled while connecting", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    let release = (): void => {};
    const held = new Promise<NatsConnection>((resolve): void => {
      release = (): void => resolve(connection(stream({})));
    });
    attach(socket, (): Promise<NatsConnection> => held);
    await Bun.sleep(30);
    cancel(socket);
    release();
    await Bun.sleep(50);

    expect(frames).toEqual([]);
  });

  test("stays silent when cancelled while reading the snapshot", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    let release = (): void => {};
    const infoGate = new Promise<void>((resolve): void => {
      release = resolve;
    });
    attach(socket, async (): Promise<NatsConnection> =>
      connection(stream({ infoGate: infoGate })),
    );
    await Bun.sleep(30);
    cancel(socket);
    release();
    await Bun.sleep(50);

    expect(frames).toEqual([]);
  });

  test("reports a NATS connection failure", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    attach(socket, async (): Promise<NatsConnection> => {
      throw new Error("nats down");
    });
    await until((): boolean => frames.length > 0);

    expect(frames).toEqual([{ type: "error", error: "nats down" }]);
  });
});

describe("runCoreStream", (): void => {
  test("reports a start that never answers", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    globalThis.fetch = ((_url: string, init: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject): void => {
        const fail = (): void => reject(new Error("aborted"));
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener("abort", fail);
      })) as unknown as typeof fetch;
    execute(
      socket,
      async (): Promise<NatsConnection> => connection(stream({})),
      30,
    );
    await until((): boolean => has(frames, "error"));

    expect(frames.at(-1)).toEqual({
      type: "error",
      error: "Run start timed out",
    });
  });

  test("reports a NATS connection failure", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    execute(socket, async (): Promise<NatsConnection> => {
      throw new Error("nats down");
    });
    await until((): boolean => has(frames, "error"));

    expect(frames.at(-1)).toEqual({ type: "error", error: "nats down" });
  });

  test("streams a run's frames live and survives a failing ack", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    globalThis.fetch = (async (): Promise<Response> =>
      json(202, {
        eventId: "run-1",
        status: "queued",
      })) as unknown as typeof fetch;
    const fake = stream({
      consume: async (): Promise<FakeConsumer> =>
        messageConsumer([
          {
            afterMs: 0,
            message: streamMessage(
              21,
              "run-1",
              { type: "text-delta" },
              (): void => {
                throw new Error("ack failed");
              },
            ),
          },
          { afterMs: 0, message: streamMessage(22, "run-1", { type: "done" }) },
        ]),
    });
    execute(socket, async (): Promise<NatsConnection> => connection(fake));
    await until((): boolean =>
      frames.some(
        (frame): boolean =>
          (frame.data as { type?: string } | undefined)?.type === "done",
      ),
    );

    expect(
      frames
        .filter((frame): boolean => frame.type === "output")
        .map((frame): unknown => frame.replay),
    ).toEqual([false, false]);
  });

  test("keeps the NATS tail open while newer frames arrive, then ends", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    const fake = stream({
      infoLastSequences: [20, 25],
      consume: async (): Promise<FakeConsumer> =>
        messageConsumer([
          {
            afterMs: 700,
            message: streamMessage(25, "other", { type: "text-delta" }),
          },
        ]),
    });
    globalThis.fetch = (async (): Promise<Response> =>
      json(200, {
        agentId: "agent_1",
        conversationKey: "conversation",
        eventId: "event",
        status: "completed",
      })) as unknown as typeof fetch;
    attach(socket, async (): Promise<NatsConnection> => connection(fake));
    await until((): boolean => has(frames, "done"));

    expect(frames.at(-1)?.type).toBe("done");
  });

  test("ends the tail wait once the stream settles", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    const fake = stream({
      consume: async (): Promise<FakeConsumer> =>
        messageConsumer([{ afterMs: 200 }]),
    });
    globalThis.fetch = (async (): Promise<Response> =>
      json(200, {
        agentId: "agent_1",
        conversationKey: "conversation",
        eventId: "event",
        status: "completed",
      })) as unknown as typeof fetch;
    attach(socket, async (): Promise<NatsConnection> => connection(fake));
    await until((): boolean => has(frames, "done"));

    expect(frames.at(-1)?.type).toBe("done");
  });

  test("waits quietly when no status url is known", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    globalThis.fetch = (async (): Promise<Response> =>
      json(202, {
        eventId: "run-1",
        status: "queued",
      })) as unknown as typeof fetch;
    execute(socket, async (): Promise<NatsConnection> =>
      connection(stream({})),
    );
    await Bun.sleep(1_300);

    expect(frames.filter((frame): boolean => frame.type === "status")).toEqual(
      [],
    );
  });

  test("returns a non-JSON refusal as plain text", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("upstream exploded", {
        status: 502,
      })) as unknown as typeof fetch;
    execute(socket, async (): Promise<NatsConnection> =>
      connection(stream({})),
    );
    await until((): boolean => has(frames, "error"));

    expect(frames.at(-1)).toEqual({
      type: "error",
      status: 502,
      error: "upstream exploded",
    });
  });
});

describe("control input", (): void => {
  async function startRun(): Promise<{ socket: AgentSocket; frames: Frame[] }> {
    const made = makeSocket();
    let started = false;
    globalThis.fetch = (async (): Promise<Response> => {
      started = true;

      return new Promise<Response>((): void => {});
    }) as unknown as typeof fetch;
    execute(made.socket, async (): Promise<NatsConnection> =>
      connection(stream({})),
    );
    await until((): boolean => started);

    return made;
  }

  function control(socket: AgentSocket, id: string): void {
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "control",
        requestId: id,
        eventId: id,
        mode: "steer",
        input: "more",
      }),
      limits(5_000),
      async (): Promise<NatsConnection> => connection(stream({})),
    );
  }

  test("refuses a ninth control in flight", async (): Promise<void> => {
    const { socket, frames } = await startRun();
    for (let index = 0; index < 9; index += 1) control(socket, `c${index}`);
    await until((): boolean => has(frames, "status"));

    expect(frames.at(-1)).toEqual({
      type: "status",
      requestId: "c8",
      eventId: "c8",
      status: "failed",
      error: "Too many control inputs in flight on this WebSocket (max 8)",
    });
  });

  test("reports a control request that fails to send", async (): Promise<void> => {
    const { socket, frames } = await startRun();
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("core unreachable");
    }) as unknown as typeof fetch;
    control(socket, "c1");
    await until((): boolean => has(frames, "status"));

    expect(frames.at(-1)).toEqual({
      type: "status",
      requestId: "c1",
      eventId: "c1",
      status: "not_found",
      error: "core unreachable",
    });
  });

  test("keeps polling after a status read fails", async (): Promise<void> => {
    const { socket, frames } = await startRun();
    const answers: Array<() => Response> = [
      (): Response =>
        json(202, { eventId: "c1", status: "queued", runId: "run_c" }),
      (): Response => {
        throw new Error("status read failed");
      },
      (): Response => json(200, { status: "applied" }),
    ];
    globalThis.fetch = (async (): Promise<Response> =>
      (
        answers.shift() ?? ((): Response => json(200, {}))
      )()) as unknown as typeof fetch;
    control(socket, "c1");
    await until((): boolean => frames.at(-1)?.status === "applied", 6_000);

    expect(frames.at(-1)).toMatchObject({ type: "status", status: "applied" });
  });
});
