import { describe, expect, it } from "bun:test";
import type { ForwarderConfig } from "../src/config.ts";
import type { DiscordConnection } from "../src/connections.ts";
import {
  Forwarder,
  groupConnectionsByToken,
  type ForwarderSocket,
} from "../src/supervisor.ts";
import type { GatewaySocketOptions } from "../src/socket.ts";

const CONFIG: ForwarderConfig = {
  backoffCeilingMs: 300_000,
  identifyLimit: 10,
  pollIntervalMs: 30_000,
  port: 3000,
  webhookBaseUrl: "https://gateway.example.com",
};

class StubSocket implements ForwarderSocket {
  botIdentity: string | null = null;
  state: "ready" | "stopped" = "stopped";
  started = 0;
  stopped = 0;

  start(): void {
    this.started += 1;
    this.state = "ready";
  }

  stop(): void {
    this.stopped += 1;
    this.state = "stopped";
  }
}

function connection(
  overrides: Partial<DiscordConnection> = {},
): DiscordConnection {
  return {
    agentId: "agent-1",
    agentName: "support",
    botToken: "token-a",
    webhookPath: "/webhooks/account-1/dev/endpoint-1/discord",
    ...overrides,
  };
}

function stubbedForwarder(): {
  forwarder: Forwarder;
  sockets: Map<string, StubSocket>;
} {
  const sockets = new Map<string, StubSocket>();

  return {
    forwarder: new Forwarder(CONFIG, (options: GatewaySocketOptions) => {
      const socket = new StubSocket();
      sockets.set(options.botToken, socket);

      return socket;
    }),
    sockets: sockets,
  };
}

describe("grouping connections", () => {
  it("joins the webhook path onto the configured base URL", () => {
    const grouped = groupConnectionsByToken(
      [connection()],
      CONFIG.webhookBaseUrl,
    );

    expect(grouped.get("token-a")).toEqual([
      {
        agentId: "agent-1",
        agentName: "support",
        webhookUrl:
          "https://gateway.example.com/webhooks/account-1/dev/endpoint-1/discord",
      },
    ]);
  });

  it("keeps two agents on one token to a single socket", () => {
    const grouped = groupConnectionsByToken(
      [
        connection(),
        connection({ agentId: "agent-2", webhookPath: "/webhooks/a/discord" }),
      ],
      CONFIG.webhookBaseUrl,
    );

    expect(grouped.size).toBe(1);
    expect(grouped.get("token-a")).toHaveLength(2);
  });
});

describe("reconcile", () => {
  it("opens one socket per token", () => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([
      connection(),
      connection({ agentId: "agent-2", botToken: "token-b" }),
    ]);

    expect(sockets.size).toBe(2);
    expect(sockets.get("token-a")?.started).toBe(1);
    expect(sockets.get("token-b")?.started).toBe(1);
  });

  it("leaves an unchanged token's socket alone", () => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([connection({ agentName: "renamed" })]);

    expect(sockets.get("token-a")?.started).toBe(1);
    expect(sockets.get("token-a")?.stopped).toBe(0);
    expect(forwarder.status().targets).toBe(1);
  });

  it("closes a socket whose connection disappeared", () => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([]);

    expect(sockets.get("token-a")?.stopped).toBe(1);
    expect(forwarder.status().sockets).toHaveLength(0);
  });

  it("treats a rotated token as a close and a re-dial", () => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([connection({ botToken: "token-rotated" })]);

    expect(sockets.get("token-a")?.stopped).toBe(1);
    expect(sockets.get("token-rotated")?.started).toBe(1);
    expect(forwarder.status().sockets).toHaveLength(1);
  });

  it("re-points an existing socket at an added agent without reconnecting", () => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([
      connection(),
      connection({ agentId: "agent-2", webhookPath: "/webhooks/a/discord" }),
    ]);

    expect(sockets.get("token-a")?.started).toBe(1);
    expect(forwarder.status().targets).toBe(2);
  });

  it("stops every socket on shutdown", () => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([
      connection(),
      connection({ agentId: "agent-2", botToken: "token-b" }),
    ]);
    forwarder.stop();

    expect(sockets.get("token-a")?.stopped).toBe(1);
    expect(sockets.get("token-b")?.stopped).toBe(1);
    expect(forwarder.status().sockets).toHaveLength(0);
  });
});
