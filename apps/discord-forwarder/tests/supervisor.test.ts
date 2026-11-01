import { afterEach, describe, expect, it } from "bun:test";
import type { ForwarderConfig } from "../src/config.ts";
import type { ForwarderConnection } from "../src/connections.ts";
import type { MessageCreate } from "../src/discord.ts";
import type { GatewaySocketOptions, SocketState } from "../src/socket.ts";
import {
  Forwarder,
  groupConnectionsByToken,
  type ForwarderSocket,
} from "../src/supervisor.ts";

const CONFIG: ForwarderConfig = {
  backoffCeilingMs: 300_000,
  identifyLimit: 10,
  planes: [],
  port: 3000,
};

const realFetch = globalThis.fetch;

class StubSocket implements ForwarderSocket {
  botIdentity: string | null = null;
  state: SocketState = "stopped";
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
      "https://gateway.example.com/v1/webhooks/account-1/dev/endpoint-1/discord",
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
  it("keeps a token deployed to two planes on a single socket", () => {
    const grouped = groupConnectionsByToken([
      connection({
        webhookUrl: "https://gateway.dev.example.com/v1/webhooks/a/discord",
      }),
      connection({
        agentId: "agent-2",
        webhookUrl: "https://gateway.example.com/v1/webhooks/b/discord",
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
        webhookUrl: "https://gateway.example.com/v1/webhooks/a/discord",
      }),
    ]);

    expect(sockets.get("token-a")?.started).toBe(1);
    expect(forwarder.status().targets).toBe(2);
  });

  it("keeps a fatal socket parked when only another token changes", (): void => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    const parked = sockets.get("token-a")!;
    parked.state = "fatal";

    forwarder.reconcile([
      connection(),
      connection({ agentId: "agent-2", botToken: "token-b" }),
    ]);

    expect(parked.stopped).toBe(0);
    expect(sockets.get("token-a")).toBe(parked);
  });

  it("replaces a fatal socket when its own connections change", (): void => {
    const { forwarder, sockets } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    const parked = sockets.get("token-a")!;
    parked.state = "fatal";

    forwarder.reconcile([connection({ agentName: "renamed" })]);

    expect(parked.stopped).toBe(1);
    expect(sockets.get("token-a")).not.toBe(parked);
    expect(sockets.get("token-a")?.started).toBe(1);
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

  it("posts where reconcile last pointed the token, not where it started", async () => {
    const posted: string[] = [];
    let releaseLookup: (() => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      // Parsed host, not startsWith, which would also accept discord.com.example.test.
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
      const forwarder = new Forwarder(CONFIG, (options): StubSocket => {
        deliver = options.onMessageCreate;

        return new StubSocket();
      });
      forwarder.reconcile([
        connection({
          webhookUrl: "https://gateway.example.com/v1/webhooks/old",
        }),
      ]);
      deliver?.({
        channel_id: "channel-1",
        guild_id: "guild-1",
        id: "message-1",
      });

      await until(() => releaseLookup !== undefined);
      forwarder.reconcile([
        connection({
          webhookUrl: "https://gateway.example.com/v1/webhooks/new",
        }),
      ]);
      releaseLookup?.();
      await until((): boolean => posted.length > 0);

      expect(posted).toEqual(["https://gateway.example.com/v1/webhooks/new"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("delivery", (): void => {
  afterEach((): void => {
    globalThis.fetch = realFetch;
  });

  it("drops a guild message whose thread lookup keeps failing", async (): Promise<void> => {
    const { deliver, lookups, posted } = delivering();
    deliver({ channel_id: "thread-1", guild_id: "guild-1", id: "message-1" });

    await until((): boolean => lookups.length === 2);
    await Bun.sleep(5);

    expect(posted).toEqual([]);
  });

  it("forwards a DM without looking up a thread", async (): Promise<void> => {
    const { deliver, lookups, posted } = delivering();
    deliver({ channel_id: "dm-1", id: "message-1" });

    await until((): boolean => posted.length > 0);

    expect(lookups).toEqual([]);
  });
});

function delivering(): {
  deliver: (data: MessageCreate) => void;
  lookups: string[];
  posted: string[];
} {
  const lookups: string[] = [];
  const posted: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if (new URL(url).hostname === "discord.com") {
      lookups.push(url);

      return new Response("", {
        headers: { "Retry-After": "0.001" },
        status: 429,
      });
    }
    posted.push(url);

    return new Response("", { status: 200 });
  }) as typeof fetch;
  let deliver: (data: MessageCreate) => void = (): void => {};
  const forwarder = new Forwarder(CONFIG, (options): StubSocket => {
    deliver = options.onMessageCreate;

    return new StubSocket();
  });
  forwarder.reconcile([connection()]);

  return { deliver: deliver, lookups: lookups, posted: posted };
}

async function until(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    if (done()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition never became true");
}
