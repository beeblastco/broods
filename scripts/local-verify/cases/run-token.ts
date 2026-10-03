import { sealRunToken } from "../../../apps/core/src/shared/run-token.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

interface Answer {
  status: number;
  body: string;
}

/**
 * A run token (`fp_run_`) is a core credential for one agent run. The config
 * plane refuses the prefix outright and core refuses one it did not sign. A
 * genuine one reads its own agent's run, and is refused another agent's run
 * and starting a run of its own.
 */
export async function runToken(context: VerifyContext): Promise<void> {
  const send = async (
    method: string,
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<Answer> => {
    const response = await fetch(`${context.gatewayUrl}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(10_000),
    });

    return { status: response.status, body: await response.text() };
  };
  const forged = "fp_run_e30.forged";

  const config = await context.measure("run token on config plane", () =>
    send("GET", "/v1/agents", forged),
  );
  assertStep(
    "the config plane refuses a run token by its prefix",
    config.status === 401 &&
      config.body.includes("run tokens cannot reach the config plane"),
    `${config.status} ${config.body.slice(0, 200)}`,
  );

  const unsigned = await send("POST", "/v1/runs", forged);
  assertStep(
    "core refuses a run token it did not sign",
    unsigned.status === 401,
    `${unsigned.status} ${unsigned.body.slice(0, 200)}`,
  );

  const name = `run-token-${context.runId}`;
  const agentConfig = {
    ...context.model,
    instructions: "Reply with the single word OK.",
  };
  const [{ accountId }, own, other] = await Promise.all([
    context.account.getAccount(),
    context.account.createAgent({ name: name, config: agentConfig }),
    context.account.createAgent({ name: `${name}-other`, config: agentConfig }),
  ]);
  const startRun = async (agentId: string): Promise<string> =>
    (
      await context.client.runAsync({
        agentId: agentId,
        conversationKey: name,
        eventId: name,
        input: "Say OK.",
      })
    ).runId;
  const [ownRunId, otherRunId] = await Promise.all([
    startRun(own.agentId),
    startRun(other.agentId),
  ]);
  // Core's own signer, on the secret this stack's core derives its key from.
  process.env.STAGE_TICKET_SECRET = context.stageTicketSecret;
  const token = sealRunToken({ accountId: accountId, agentId: own.agentId });

  const read = await context.measure("run token reads its run", () =>
    send("GET", `/v1/runs/${ownRunId}`, token),
  );
  assertStep(
    "a run token reads its own agent's run",
    read.status === 200,
    `${read.status} ${read.body.slice(0, 200)}`,
  );
  const foreign = await send("GET", `/v1/runs/${otherRunId}`, token);
  assertStep(
    "a run token is refused another agent's run",
    foreign.status === 403 && foreign.body.includes("run_token_scope"),
    `${foreign.status} ${foreign.body.slice(0, 200)}`,
  );
  const started = await send("POST", "/v1/runs", token, {
    agentId: own.agentId,
    eventId: `${name}-token`,
    conversationKey: name,
    events: [{ role: "user", content: [{ type: "text", text: "Say OK." }] }],
  });
  assertStep(
    "a run token starts no run, its own agent's included",
    started.status === 403 &&
      started.body.includes("run_token_scope") &&
      started.body.includes("not enabled yet"),
    `${started.status} ${started.body.slice(0, 200)}`,
  );
}
