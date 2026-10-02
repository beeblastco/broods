import type { ChatGPTConnection } from "../../../packages/broods/src/account.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import { assertStep, runToTerminal, type VerifyContext } from "../harness.ts";

/**
 * The `chatgpt` provider end to end, short of OpenAI: a run with no sign-in
 * fails asking for one (core reads the account's login through Convex), and a
 * sign-in stored through the gateway reads back without its tokens and logs
 * out. The OpenAI half needs a real ChatGPT Plus or Pro account, so it is not
 * here; `apps/core/tests/chatgpt-provider.test.ts` covers it against a stub.
 */
export async function chatgptSignIn(context: VerifyContext): Promise<void> {
  const key = `chatgpt-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      model: { provider: "chatgpt", modelId: "gpt-5.5" },
      instructions: "Reply with the single word OK.",
    },
  });
  const unsigned = await context.measure(
    "chatgpt run without a sign-in",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "a chatgpt run with no sign-in fails asking for one",
    unsigned.status === "failed" &&
      (unsigned.error ?? "").includes("broods login chatgpt"),
    JSON.stringify(unsigned),
  );

  const stored = await context.measure(
    "store chatgpt sign-in",
    (): Promise<ChatGPTConnection> =>
      context.account.connectChatGPT({
        clientId: "client-local-verify",
        hostId: `urn:uuid:${context.runId}`,
        email: "verify@example.com",
        scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        accessToken: "access-local-verify",
        refreshToken: "refresh-local-verify",
      }),
  );
  const status = await context.account.getChatGPTConnection();
  assertStep(
    "a stored sign-in reads back connected, with plan usage, without tokens",
    stored.connected &&
      status.connected &&
      status.planUsage &&
      status.clientId === "client-local-verify" &&
      !JSON.stringify(status).includes("access-local-verify") &&
      !JSON.stringify(status).includes("refresh-local-verify"),
    JSON.stringify(status),
  );

  const deleted = await context.account.disconnectChatGPT();
  const after = await context.account.getChatGPTConnection();
  assertStep(
    "logout forgets the sign-in",
    deleted && !after.connected,
    JSON.stringify(after),
  );
  await context.account.deleteAgent(agentId);
}
