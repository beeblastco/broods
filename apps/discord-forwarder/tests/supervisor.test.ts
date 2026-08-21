import { describe, expect, it } from "bun:test";
import type { ForwarderConfig } from "../src/config.ts";
import type { ForwarderConnection } from "../src/connections.ts";
import type { MessageCreate } from "../src/discord.ts";
import type { GatewaySocketOptions } from "../src/socket.ts";
import {
  Forwarder,
  groupConnectionsByToken,
  type ForwarderSocket,
} from "../src/supervisor.ts";

const CONFIG: ForwarderConfig = {
  backoffCeilingMs: 300_000,
  identifyLimit: 10,
  planes: [],
  pollIntervalMs: 30_000,
  port: 3000,
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
  overrides: Partial<ForwarderConnection> = {},
): ForwarderConnection {
  return {
    agentId: "agent-1",
    agentName: "support",
    botToken: "token-a",
    webhookUrl:
      "https://gateway.example.com/webhooks/account-1/dev/endpoint-1/discord",
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
  it("keys each connection's resolved webhook by bot token", () => {
    const grouped = groupConnectionsByToken([connection()]);

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
    const grouped = groupConnectionsByToken([
      connection(),
      connection({
        agentId: "agent-2",
        webhookUrl: "https://gateway.example.com/webhooks/a/discord",
      }),
    ]);

    expect(grouped.size).toBe(1);
    expect(grouped.get("token-a")).toHaveLength(2);
  });

  // The reason one process reads every config plane rather than one process per
  // plane: two planes sharing a bot token have to share its socket, or Discord
  // delivers every event to both and the message is answered twice.
  it("keeps a token deployed to two planes on a single socket", () => {
    const grouped = groupConnectionsByToken([
      connection({
        webhookUrl: "https://gateway.dev.example.com/webhooks/a/discord",
      }),
      connection({
        agentId: "agent-2",
        webhookUrl: "https://gateway.example.com/webhooks/b/discord",
      }),
    ]);

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
      connection({
        agentId: "agent-2",
        webhookUrl: "https://gateway.example.com/webhooks/a/discord",
      }),
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

  // The thread lookup waits on Discord, so a poll can land mid-delivery. Reading
  // the targets before that await would post to the webhooks the token had when
  // the message arrived rather than the ones it has now.
  it("posts where reconcile last pointed the token, not where it started", async () => {
    const realFetch = globalThis.fetch;
    const posted: string[] = [];
    let releaseLookup: (() => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      // Matched on the parsed host, not a prefix: `startsWith` would also accept
      // `https://discord.com.example.test`, which is the substring-sanitisation
      // shape worth never writing, test or not.
      if (new URL(url).hostname === "discord.com") {
        await new Promise<void>((resolve) => {
          releaseLookup = resolve;
        });

        return Response.json({ id: "channel-1", type: 0 });
      }
      posted.push(url);

      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      let deliver: ((data: MessageCreate) => void) | undefined;
      const forwarder = new Forwarder(CONFIG, (options) => {
        deliver = options.onMessageCreate;

        return new StubSocket();
      });
      forwarder.reconcile([
        connection({ webhookUrl: "https://gateway.example.com/webhooks/old" }),
      ]);
      deliver?.({ channel_id: "channel-1", id: "message-1" });

      await until(() => releaseLookup !== undefined);
      forwarder.reconcile([
        connection({ webhookUrl: "https://gateway.example.com/webhooks/new" }),
      ]);
      releaseLookup?.();
      await until(() => posted.length > 0);

      expect(posted).toEqual(["https://gateway.example.com/webhooks/new"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** Waits for a fire-and-forget delivery to reach the state under test. */
async function until(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    if (done()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition never became true");
}
