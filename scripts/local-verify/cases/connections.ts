import type { Connection } from "../../../packages/convex/model/connections.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

/**
 * Connections end to end, short of the providers: a `chatgpt` run with no
 * connection fails asking for one (core reads it through Convex), and a
 * connection stored through the gateway lists and reads back without its
 * tokens or client secret, then disconnects. The provider half needs real
 * accounts, so it is not here; the core and CLI tests cover it against stubs.
 */
export async function connections(context: VerifyContext): Promise<void> {
  const key = `connections-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      model: { provider: "chatgpt", modelId: "gpt-5.5" },
      instructions: "Reply with the single word OK.",
    },
  });
  const unsigned = await context.measure(
    "chatgpt run without a connection",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "a chatgpt run with no connection fails asking for one",
    unsigned.status === "failed" &&
      (unsigned.error ?? "").includes("broods connect chatgpt"),
    JSON.stringify(unsigned),
  );

  await context.measure("store a connection", (): Promise<Connection> =>
    context.account.connect("gmail", {
      type: "google",
      clientId: "client-local-verify",
      clientSecret: "secret-local-verify",
      email: "verify@example.com",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      accessToken: "access-local-verify",
      refreshToken: "refresh-local-verify",
    }),
  );
  const listed = await context.account.listConnections();
  const one = await context.account.getConnection("gmail");
  assertStep(
    "a stored connection lists and reads back without its secrets",
    listed.some((connection) => connection.name === "gmail") &&
      one?.type === "google" &&
      !JSON.stringify(listed).includes("access-local-verify") &&
      !JSON.stringify(listed).includes("secret-local-verify"),
    JSON.stringify(listed),
  );

  const deleted = await context.account.disconnect("gmail");
  assertStep(
    "a disconnect forgets the connection",
    deleted && (await context.account.getConnection("gmail")) === null,
    JSON.stringify(await context.account.listConnections()),
  );
  await context.account.deleteAgent(agentId);
}
