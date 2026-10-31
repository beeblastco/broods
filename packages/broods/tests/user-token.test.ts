import { afterEach, expect, test } from "bun:test";
import { openBrowserTicket } from "../../convex/model/browserTicket.ts";
import { openUserToken } from "../../convex/model/userToken.ts";
import { BroodsClient } from "../src/client.ts";
import {
  signBrowserTicket,
  signUserToken,
  USER_TOKEN_HEADER,
} from "../src/user-token.ts";
import { webSocketSubprotocols } from "../src/websocket.ts";

const SECRET = "bsig_sdk-test-secret";

afterEach(() => {
  delete process.env.BROODS_USER_TOKEN_SECRET;
});

test("signUserToken signs a token core opens with the same secret", async () => {
  process.env.BROODS_USER_TOKEN_SECRET = SECRET;
  const token = await signUserToken({
    userId: "user_123",
    conversations: ["chat-1"],
  });

  expect(await openUserToken(token, SECRET)).toMatchObject({
    userId: "user_123",
    conversations: ["chat-1"],
  });
  expect(await openUserToken(token, "bsig_other")).toBeNull();
});

test("signBrowserTicket signs a ticket core opens, one fresh jti each time", async () => {
  process.env.BROODS_USER_TOKEN_SECRET = SECRET;
  const first = await signBrowserTicket({ userId: "user_123", sandbox: "web" });
  const second = await signBrowserTicket({
    userId: "user_123",
    sandbox: "web",
  });
  const opened = await openBrowserTicket(first, SECRET);

  expect(opened).toMatchObject({ userId: "user_123", sandbox: "web" });
  expect(opened?.jti).not.toBe((await openBrowserTicket(second, SECRET))?.jti);
  expect(await openUserToken(first, SECRET)).toBeNull();
  expect(
    await signBrowserTicket({
      userId: "user_123",
      sandbox: "web",
      ttlMs: 16 * 60_000,
    }).then(
      (): string => "signed",
      (error: unknown): string => String(error),
    ),
  ).toContain("Invalid browser ticket");
});

test("signUserToken refuses without a secret, with the runtime key, or past an hour", async () => {
  const refusal = (input: Parameters<typeof signUserToken>[0]) =>
    signUserToken(input).then(
      (): string => "signed",
      (error: unknown): string => String(error),
    );

  expect(await refusal({ userId: "user_123" })).toContain(
    "BROODS_USER_TOKEN_SECRET",
  );
  expect(
    await refusal({ userId: "user_123", secret: "bsk_runtime" }),
  ).toContain("must start with bsig_");
  expect(
    await refusal({
      userId: "user_123",
      secret: SECRET,
      ttlMs: 2 * 60 * 60 * 1000,
    }),
  ).toContain("Invalid user token");
});

test("the client sends a fresh user token beside the runtime key on every call", async () => {
  const sent: Array<string | null> = [];
  let minted = 0;
  const client = new BroodsClient({
    apiKey: "bsk_key",
    userToken: async () => `buat_${++minted}`,
    fetch: async (_input, init) => {
      sent.push(new Headers(init?.headers).get(USER_TOKEN_HEADER));

      return Response.json(
        {
          eventId: "e",
          runId: "run_1",
          status: "accepted",
          statusUrl: "/v1/runs/run_1",
        },
        { status: 202 },
      );
    },
  });

  await client.runAsync({ agentId: "agent_1", input: "hi" });
  await client.runAsync({ agentId: "agent_1", input: "hi" });

  expect(sent).toEqual(["buat_1", "buat_2"]);
});

test("the user token rides the websocket subprotocols, never the URL", () => {
  expect(webSocketSubprotocols("bsk_key", "buat_x")).toEqual([
    "broods.v1",
    "broods.token.bsk_key",
    "broods.user.buat_x",
  ]);
  expect(webSocketSubprotocols("bsk_key")).toEqual([
    "broods.v1",
    "broods.token.bsk_key",
  ]);
});
