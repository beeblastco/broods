import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import type { ConnectionStartResult } from "../../../packages/convex/model/connections.ts";
import {
  OK_AGENT,
  assertStep,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

// Signing in needs a real browser and account; Convex tests cover the code exchange on a stub.
export async function connections(context: VerifyContext): Promise<void> {
  const key = `connections-${context.runId}`;
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      model: { provider: "chatgpt", modelId: "gpt-5.5" },
      agent: OK_AGENT,
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

  const start = {
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    codeChallenge: "verify-challenge",
    state: key,
    nonce: key,
  };
  const started = await context.measure(
    "start a chatgpt sign-in",
    (): Promise<ConnectionStartResult> =>
      context.account.startConnection("chatgpt", start),
  );
  const query = new URL(started.authorizeUrl).searchParams;
  assertStep(
    "start answers ChatGPT's consent screen on a registering client",
    query.get("client_id") === "dynamic_agent_client" &&
      query.get("redirect_uri") === start.redirectUri &&
      query.get("ext_agent_host_id") === started.hostId,
    started.authorizeUrl,
  );

  assertStep(
    "a disconnect with nothing connected answers false",
    !(await context.account.disconnect("chatgpt")),
    "deleted a connection that did not exist",
  );
  await context.account.deleteAgent(agentId);
}
