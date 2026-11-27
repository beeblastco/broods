import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  connectionFetch,
  resetConnectionsForTests,
} from "../../../../apps/core/src/harness/connections.ts";
import {
  setStorageForTests,
  type Storage,
  type StoredConnection,
} from "../../../../apps/core/src/shared/storage.ts";

const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const realFetch = globalThis.fetch;

let rows: Map<string, StoredConnection>;
let loads: string[];
let saves: string[];
let refusals: number;
let tokenAnswer: () => Response;
let sent: Array<string | null>;
let refuseToken: string | undefined;

beforeEach((): void => {
  rows = new Map();
  loads = [];
  saves = [];
  refusals = 0;
  sent = [];
  refuseToken = undefined;
  tokenAnswer = (): Response =>
    Response.json({
      access_token: "access-rotated",
      refresh_token: "refresh-rotated",
      expires_in: 600,
    });
  resetConnectionsForTests();
  setStorageForTests({
    connections: {
      load: async (accountId: string): Promise<StoredConnection | null> => {
        loads.push(accountId);

        return rows.get(accountId) ?? null;
      },
      saveRefreshed: async (accountId: string): Promise<boolean> => {
        saves.push(accountId);

        return true;
      },
    },
  } as Partial<Storage> as Storage);
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      expect(input instanceof Request ? input.url : input.toString()).toBe(
        TOKEN_URL,
      );

      return tokenAnswer();
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach((): void => {
  globalThis.fetch = realFetch;
  setStorageForTests(null);
});

describe("connection token loads", () => {
  test("each account loads its own row once and then serves it from the cache", async () => {
    const accounts = ["a0", "a1", "a2", "a3", "a4", "a5"];
    for (const account of accounts) rows.set(account, row(`token-${account}`));

    for (let round = 0; round < 2; round += 1) {
      for (const account of accounts) await send(account);
    }

    expect(loads).toEqual(accounts);
    expect(sent).toEqual(
      [...accounts, ...accounts].map((account) => `Bearer token-${account}`),
    );
  });

  test("a refused token is refreshed once and the request is sent again", async () => {
    rows.set("a1", row("stale"));
    refuseToken = "stale";

    const response = await send("a1");

    expect(response.status).toBe(200);
    expect(refusals).toBe(1);
    expect(saves).toEqual(["a1"]);
    expect(sent).toEqual(["Bearer stale", "Bearer access-rotated"]);
  });

  test("a token about to expire is refreshed before the first request", async () => {
    rows.set("a1", row("old", { expiresAt: Date.now() + 10_000 }));

    await send("a1");

    expect(saves).toEqual(["a1"]);
    expect(sent[0]).toBe("Bearer access-rotated");
  });

  test("an account with no connection is told to connect, and may connect later", async () => {
    await expect(send("a1")).rejects.toThrow(
      "This account has no chatgpt connection. Run `broods connect chatgpt` to sign in.",
    );

    rows.set("a1", row("fresh"));
    const response = await send("a1");

    expect(response.status).toBe(200);
    expect(sent).toEqual(["Bearer fresh"]);
  });

  test("a refresh the endpoint refuses names the connection and tells the account to sign in again", async () => {
    rows.set("a1", row("old", { expiresAt: Date.now() + 10_000 }));
    tokenAnswer = (): Response => new Response("denied", { status: 400 });

    await expect(send("a1")).rejects.toThrow(
      "ChatGPT plan connection could not refresh: status 400 denied. Run `broods connect chatgpt` to sign in again.",
    );
    expect(sent).toEqual([]);
  });
});

async function send(account: string): Promise<Response> {
  const fetcher = connectionFetch(
    account,
    "chatgpt",
    async (_input, init): Promise<Response> => {
      const authorization = new Headers(init?.headers).get("Authorization");
      sent.push(authorization);
      if (authorization === `Bearer ${refuseToken}`) {
        refusals += 1;

        return new Response("no", { status: 401 });
      }

      return new Response("ok");
    },
  );

  return await fetcher("https://api.openai.com/v1/responses");
}

function row(
  accessToken: string,
  overrides: Partial<StoredConnection> = {},
): StoredConnection {
  return {
    type: "chatgpt",
    scopes: ["chatgpt.tokens.use.direct"],
    accessToken: accessToken,
    refreshToken: "refresh-1",
    clientId: "client-1",
    expiresAt: Date.now() + 3_600_000,
    updatedAt: 1,
    ...overrides,
  };
}
