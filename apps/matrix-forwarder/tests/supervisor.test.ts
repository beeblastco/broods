import { afterEach, describe, expect, it } from "bun:test";
import type { MatrixForwardedEvent } from "../../core/src/shared/matrix-wire.ts";
import type { AccountState, MatrixAccountOptions } from "../src/account.ts";
import type { MatrixConnection } from "../src/connections.ts";
import {
  Forwarder,
  groupConnectionsByToken,
  type ForwarderAccount,
} from "../src/supervisor.ts";

const EVENT: MatrixForwardedEvent = {
  type: "MATRIX_ROOM_EVENT",
  encrypted: false,
  event: {
    content: { body: "hi", msgtype: "m.text" },
    event_id: "$event-1",
    origin_server_ts: 1,
    sender: "@ada:example.org",
    type: "m.room.message",
  },
  roomId: "!room:example.org",
  userId: "@bot:example.org",
};

const realFetch = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = realFetch;
});

describe("grouping connections", () => {
  // The same account deployed to dev and prod is one sync loop and one crypto
  // store, fanned out to both webhooks.
  it("keeps a token deployed to two planes on a single account", () => {
    const grouped = groupConnectionsByToken([
      connection(),
      connection({
        agentId: "agent-2",
        webhookUrl: "https://gateway.example.com/v1/webhooks/a/matrix",
      }),
    ]);

    expect(grouped.size).toBe(1);
    expect(grouped.get("token-a")).toEqual({
      apiUrl: "https://matrix.example.org",
      targets: [
        {
          agentId: "agent-1",
          agentName: "support",
          webhookUrl:
            "https://gateway.dev.example.com/v1/webhooks/a/dev/e1/matrix",
        },
        {
          agentId: "agent-2",
          agentName: "support",
          webhookUrl: "https://gateway.example.com/v1/webhooks/a/matrix",
        },
      ],
    });
  });

  // Two planes may spell one homeserver with and without its trailing slash.
  // Read as two, the later plane's webhook would be dropped as a conflict.
  it("treats homeservers that differ only by a trailing slash as one", () => {
    const grouped = groupConnectionsByToken([
      connection(),
      connection({
        agentId: "agent-2",
        apiUrl: "https://matrix.example.org/",
      }),
    ]);

    expect(grouped.get("token-a")?.apiUrl).toBe("https://matrix.example.org");
    expect(grouped.get("token-a")?.targets).toHaveLength(2);
  });

  it("drops the connection when one token names a second homeserver", () => {
    const grouped = groupConnectionsByToken([
      connection(),
      connection({ agentId: "agent-2", apiUrl: "https://other.example.org" }),
    ]);

    expect(grouped.get("token-a")?.apiUrl).toBe("https://matrix.example.org");
    expect(grouped.get("token-a")?.targets).toHaveLength(1);
  });
});

describe("reconcile", () => {
  it("starts one account per token with the store directory", () => {
    const { accounts, forwarder } = stubbedForwarder();
    forwarder.reconcile([
      connection(),
      connection({ agentId: "agent-2", botToken: "token-b" }),
    ]);

    expect(
      accounts.map((account): string => account.options.accessToken),
    ).toEqual(["token-a", "token-b"]);
    expect(accounts.every((account): boolean => account.started === 1)).toBe(
      true,
    );
    expect(accounts[0]?.options.storeDir).toBe("/data");
    expect(forwarder.account("token-b")).toBe(accounts[1]);
  });

  it("re-points targets without restarting the account", () => {
    const { accounts, forwarder } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([
      connection(),
      connection({
        agentId: "agent-2",
        webhookUrl: "https://gateway.example.com/v1/webhooks/b/matrix",
      }),
    ]);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.stopped).toBe(0);
    expect(forwarder.status().targets).toBe(2);
  });

  it("stops an account whose connections disappeared", () => {
    const { accounts, forwarder } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([]);

    expect(accounts[0]?.stopped).toBe(1);
    expect(forwarder.account("token-a")).toBeUndefined();
    expect(forwarder.status().accounts).toHaveLength(0);
  });

  it("restarts an account whose homeserver moved", () => {
    const { accounts, forwarder } = stubbedForwarder();
    forwarder.reconcile([connection()]);
    forwarder.reconcile([connection({ apiUrl: "https://new.example.org" })]);

    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.stopped).toBe(1);
    expect(accounts[1]?.options.apiUrl).toBe("https://new.example.org");
    expect(forwarder.account("token-a")).toBe(accounts[1]);
  });

  it("stops every account on shutdown", async () => {
    const { accounts, forwarder } = stubbedForwarder();
    forwarder.reconcile([
      connection(),
      connection({ agentId: "agent-2", botToken: "token-b" }),
    ]);
    await forwarder.stop();

    expect(accounts.every((account): boolean => account.stopped === 1)).toBe(
      true,
    );
    expect(forwarder.status().accounts).toHaveLength(0);
  });

  it("delivers to where reconcile last pointed the token", async () => {
    const posted: string[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      posted.push(String(input));

      return new Response("", { status: 200 });
    }) as typeof fetch;
    const { accounts, forwarder } = stubbedForwarder();
    forwarder.reconcile([
      connection({ webhookUrl: "https://gateway.example.com/old" }),
    ]);
    forwarder.reconcile([
      connection({ webhookUrl: "https://gateway.example.com/new" }),
    ]);
    await accounts[0]?.options.onEvent(EVENT);

    expect(posted).toEqual(["https://gateway.example.com/new"]);
  });
});

class StubAccount implements ForwarderAccount {
  readonly options: MatrixAccountOptions;
  started = 0;
  state: AccountState = "stopped";
  stopped = 0;
  userId: string | null = null;

  constructor(options: MatrixAccountOptions) {
    this.options = options;
  }

  async send(): Promise<string> {
    return "$sent";
  }

  async setTyping(): Promise<void> {}

  start(): void {
    this.started += 1;
    this.state = "syncing";
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.state = "stopped";
  }
}

function connection(
  overrides: Partial<MatrixConnection> = {},
): MatrixConnection {
  return {
    agentId: "agent-1",
    agentName: "support",
    apiUrl: "https://matrix.example.org",
    botToken: "token-a",
    webhookUrl: "https://gateway.dev.example.com/v1/webhooks/a/dev/e1/matrix",
    ...overrides,
  };
}

function stubbedForwarder(): {
  accounts: StubAccount[];
  forwarder: Forwarder;
} {
  const accounts: StubAccount[] = [];

  return {
    accounts: accounts,
    forwarder: new Forwarder("/data", (options): ForwarderAccount => {
      const account = new StubAccount(options);
      accounts.push(account);

      return account;
    }),
  };
}
