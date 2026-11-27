import { afterEach, expect, test } from "bun:test";
import type { NatsConnection } from "nats.ws";
import {
  handleAgentMessage,
  type AgentTestGatewayData,
} from "../../../../apps/gateway/src/agent.ts";
import type { GatewayLimits } from "../../../../apps/gateway/src/utils.ts";

const originalFetch = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = originalFetch;
});

test.each([
  "invalid",
  "ws-responses::1",
  "ws-responses:g:-1",
  "ws-responses:g:abc",
  "ws-responses:g:9007199254740992",
  "ws-responses:g:1:extra:tail",
  "ws-responses:g:0",
  "ws-responses:g:00012",
  "ws-responses:g:9007199254740991",
  "ws-responses:g:1:event",
])(
  "attach refuses malformed or stale cursor %s",
  async (cursor: string): Promise<void> => {
    const frames: Array<{ type: string }> = [];
    const socket = {
      data: {
        kind: "agent-test",
        corePath: "/v1/agents/agent_1",
        token: "runtime-key",
        coreBaseUrl: "https://core.example",
        accountId: "acct_1",
      },
      send: (text: string): number => {
        frames.push(JSON.parse(text) as { type: string });

        return text.length;
      },
      close: (): void => {},
    } as unknown as Bun.ServerWebSocket<AgentTestGatewayData>;
    const connection = {
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
    globalThis.fetch = (async (): Promise<Response> =>
      Response.json({
        agentId: "agent_1",
        conversationKey: "conversation",
        eventId: "event",
        status: "processing",
      })) as typeof fetch;
    handleAgentMessage(
      socket,
      JSON.stringify({
        type: "attach",
        requestId: "attach",
        agentId: "agent_1",
        conversationKey: "conversation",
        eventId: "event",
        runId: "run_1",
        afterCursor: cursor,
      }),
      { runStartTimeoutMs: 5_000 } as GatewayLimits,
      async (): Promise<NatsConnection> => connection,
    );
    for (let waited = 0; waited < 1_000 && frames.length === 0; waited += 10) {
      await Bun.sleep(10);
    }

    expect(frames).toEqual([
      {
        type: "replay_unavailable",
        requestId: "attach",
        eventId: "event",
        status: "processing",
        statusUrl: "/v1/runs/run_1",
      },
    ]);
  },
);
