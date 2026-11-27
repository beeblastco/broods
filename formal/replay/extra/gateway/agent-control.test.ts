import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NatsConnection } from "nats.ws";

import {
  handleAgentMessage,
  type AgentTestGatewayData,
} from "../../../../apps/gateway/src/agent.ts";
import type { GatewayLimits } from "../../../../apps/gateway/src/utils.ts";

type AgentSocket = Bun.ServerWebSocket<AgentTestGatewayData>;
type Frame = Record<string, unknown>;

const LIMITS = { runStartTimeoutMs: 5_000 } as unknown as GatewayLimits;
const originalFetch = globalThis.fetch;
let responses: Response[] = [];

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

  return { socket: socket, frames: frames };
}

function connection(): NatsConnection {
  return {
    jetstreamManager: async (): Promise<unknown> => ({
      streams: {
        info: async (): Promise<unknown> => ({
          created: "2026-01-01T00:00:00.000Z",
          state: { last_seq: 20, subjects: {} },
        }),
        update: async (): Promise<void> => {},
      },
    }),
  } as unknown as NatsConnection;
}

async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; waited < 12_000 && !done(); waited += 10) {
    await Bun.sleep(10);
  }
  expect(done()).toBe(true);
}

function execute(
  socket: AgentSocket,
  nats: () => Promise<NatsConnection>,
): void {
  handleAgentMessage(
    socket,
    JSON.stringify({
      type: "execute",
      agentId: "agent_1",
      eventId: "run-1",
      input: "hi",
    }),
    LIMITS,
    nats,
  );
}

beforeEach((): void => {
  responses = [];
  globalThis.fetch = (async (): Promise<Response> => {
    const next = responses.shift();
    if (!next) throw new Error("no response queued");

    return next;
  }) as unknown as typeof fetch;
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
});

describe("run start answers", () => {
  test.each([
    ["completed", undefined],
    ["failed", undefined],
    ["expired", undefined],
    ["completed", "/v1/runs/run_1"],
    ["failed", "/v1/runs/run_1"],
    ["expired", "/v1/runs/run_1"],
  ])(
    "ends at once on %s (%s)",
    async (status: string, statusUrl: string | undefined): Promise<void> => {
      const { socket, frames } = makeSocket();
      responses = [
        json(202, { eventId: "run-1", status: status, statusUrl: statusUrl }),
      ];
      execute(socket, async (): Promise<NatsConnection> => connection());
      await until((): boolean =>
        frames.some(
          (frame): boolean => frame.type === "done" || frame.type === "error",
        ),
      );
      expect(frames.some((frame): boolean => frame.type === "ack")).toBe(true);
    },
  );

  test.each([400, 401, 403, 404, 409, 429, 500, 503])(
    "reports HTTP %d",
    async (status: number): Promise<void> => {
      const { socket, frames } = makeSocket();
      responses = [json(status, { error: "refused" })];
      execute(socket, async (): Promise<NatsConnection> => connection());
      await until((): boolean =>
        frames.some((frame): boolean => frame.type === "error"),
      );
      expect(frames.at(-1)).toEqual({
        type: "error",
        status: status,
        error: "refused",
      });
    },
  );

  test.each(["text/plain", "text/html", "application/xml"])(
    "refuses a %s answer",
    async (contentType: string): Promise<void> => {
      const { socket, frames } = makeSocket();
      responses = [
        new Response("ok", {
          status: 200,
          headers: { "content-type": contentType },
        }),
      ];
      execute(socket, async (): Promise<NatsConnection> => connection());
      await until((): boolean =>
        frames.some((frame): boolean => frame.type === "error"),
      );
      expect(frames.at(-1)?.error).toBe(
        "Core WebSocket start did not return JSON",
      );
    },
  );

  test.each([
    [{}],
    [{ eventId: "run-1" }],
    [{ status: "completed" }],
    [{ eventId: "run-1", status: "bogus" }],
  ])("refuses the payload %j", async (payload: Frame): Promise<void> => {
    const { socket, frames } = makeSocket();
    responses = [json(202, payload)];
    execute(socket, async (): Promise<NatsConnection> => connection());
    await until((): boolean =>
      frames.some((frame): boolean => frame.type === "error"),
    );
    expect(frames.at(-1)?.error).toBe(
      "Core did not return a WebSocket stream or ingress status",
    );
  });

  test("reports input that cannot become run events", async (): Promise<void> => {
    const { socket, frames } = makeSocket();
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "execute",
        agentId: "agent_1",
        input: "hi",
        events: [{ role: "user", content: "hi" }],
      }),
      LIMITS,
      async (): Promise<NatsConnection> => connection(),
    );
    await until((): boolean => frames.length > 0);
    expect(frames[0]?.type).toBe("error");
  });
});

interface ControlCase {
  name: string;
  answers: Response[];
  final: Frame;
}

const CONTROL_CASES: ControlCase[] = [
  {
    name: "polls to a terminal status",
    answers: [
      json(202, { eventId: "ctl-1", status: "queued", runId: "run_c" }),
      json(200, { status: "processing" }),
      json(200, { status: "processing" }),
      json(200, { status: "completed" }),
    ],
    final: { type: "status", status: "completed" },
  },
  {
    name: "stops once applied, with every optional field",
    answers: [
      json(202, {
        eventId: "ctl-1",
        status: "queued",
        runId: "run_c",
        statusUrl: "/v1/runs/run_c",
      }),
      json(200, {
        status: "applied",
        requestedMode: "steer",
        appliedMode: "steer",
        appliedToEventId: "run-1",
      }),
    ],
    final: { type: "status", status: "applied", statusUrl: "/v1/runs/run_c" },
  },
  {
    name: "stops on an unknown run",
    answers: [
      json(202, { eventId: "ctl-1", status: "accepted", runId: "run_c" }),
      json(404, {}),
    ],
    final: { type: "status", status: "not_found" },
  },
  {
    name: "carries a failed run's error",
    answers: [
      json(202, { eventId: "ctl-1", status: "accepted", runId: "run_c" }),
      json(200, { status: "failed", error: "boom" }),
    ],
    final: { type: "status", status: "failed", error: "boom" },
  },
  {
    name: "reports a refusal with its error",
    answers: [json(409, { status: "failed", error: "busy" })],
    final: { type: "status", status: "failed", error: "busy" },
  },
  {
    name: "names the HTTP status when there is no error",
    answers: [json(500, {})],
    final: {
      type: "status",
      status: "not_found",
      error: "Control input was rejected with HTTP 500",
    },
  },
  {
    name: "refuses a success with no ingress status",
    answers: [json(202, { eventId: "ctl-1", status: "bogus" })],
    final: { type: "status", status: "bogus" },
  },
  {
    name: "refuses a non-202 success",
    answers: [json(200, { eventId: "ctl-1", status: "queued" })],
    final: { type: "status", status: "queued" },
  },
];

describe("control input", () => {
  test.each(CONTROL_CASES)(
    "$name",
    async ({ answers, final }: ControlCase): Promise<void> => {
      const { socket, frames } = makeSocket();
      let release = (): void => {};
      const held = new Promise<void>((resolve): void => {
        release = resolve;
      });
      execute(socket, async (): Promise<NatsConnection> => {
        await held;

        return connection();
      });
      await until((): boolean =>
        frames.some((frame): boolean => frame.type === "meta"),
      );

      responses = [...answers];
      handleAgentMessage(
        socket,
        JSON.stringify({
          type: "control",
          requestId: "req-1",
          eventId: "ctl-1",
          mode: "steer",
          input: "more",
        }),
        LIMITS,
        async (): Promise<NatsConnection> => connection(),
      );
      await until((): boolean =>
        frames.some(
          (frame): boolean =>
            frame.type === "status" && frame.status === final.status,
        ),
      );
      await until((): boolean => responses.length === 0);
      await Bun.sleep(30);
      expect(
        frames.findLast((frame): boolean => frame.type === "status"),
      ).toMatchObject(final);

      responses = [json(500, { error: "stop" })];
      release();
      await until((): boolean =>
        frames.some((frame): boolean => frame.type === "error"),
      );
    },
    15_000,
  );

  test("fails when no run is active", (): void => {
    const { socket, frames } = makeSocket();
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "control",
        requestId: "r",
        eventId: "e",
        input: "x",
      }),
      LIMITS,
      async (): Promise<NatsConnection> => connection(),
    );
    expect(frames).toEqual([
      { type: "error", error: "No active run to control" },
    ]);
  });
});
