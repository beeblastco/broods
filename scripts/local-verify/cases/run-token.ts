import { sealRunToken } from "../../../apps/core/src/shared/run-token.ts";
import type { AuditEvent } from "../../../packages/broods/src/account.ts";
import { assertStep, pollUntil, type VerifyContext } from "../harness.ts";

interface Answer {
  status: number;
  body: string;
}

const USER_EVENT = {
  role: "user",
  content: [{ type: "text", text: "Say OK." }],
};

/**
 * A run token (`fp_run_`) is a core credential for one agent run. The config
 * plane refuses the prefix outright and core refuses one it did not sign. A
 * genuine one starts a run for its own agent, which the ledger records as
 * delegated by that agent, and is refused another agent or a tool approval.
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
  // Core's own signer, on the secret this stack's core derives its key from.
  process.env.STAGE_TICKET_SECRET = context.stageTicketSecret;
  const token = sealRunToken({
    kind: "agent",
    accountId: accountId,
    agentId: own.agentId,
    chain: [{ kind: "user", id: "U1", name: "Ada", channel: "slack" }],
  });
  const turn = {
    agentId: own.agentId,
    eventId: name,
    conversationKey: name,
    events: [USER_EVENT],
    background: true,
  };

  const started = await context.measure("run token starts a run", () =>
    send("POST", "/v1/runs", token, turn),
  );
  assertStep(
    "a run token starts a run for its own agent",
    started.status === 202,
    `${started.status} ${started.body.slice(0, 200)}`,
  );
  const { runId }: { runId?: string } = JSON.parse(started.body);
  const status = await send("GET", `/v1/runs/${runId}`, token);
  assertStep(
    "a run token reads its own agent's run",
    status.status === 200,
    `${status.status} ${status.body.slice(0, 200)}`,
  );

  const foreign = await send("POST", "/v1/runs", token, {
    ...turn,
    agentId: other.agentId,
  });
  assertStep(
    "a run token is refused another agent",
    foreign.status === 403 && foreign.body.includes("run_token_scope"),
    `${foreign.status} ${foreign.body.slice(0, 200)}`,
  );
  const approval = await send("POST", "/v1/runs", token, {
    ...turn,
    eventId: `${name}-approval`,
    events: [
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: "a1", approved: true },
        ],
      },
    ],
  });
  assertStep(
    "a run token cannot approve a tool call",
    approval.status === 403 && approval.body.includes("run_token_scope"),
    `${approval.status} ${approval.body.slice(0, 200)}`,
  );

  // The usage write that appends the row lands just after the run settles.
  const row = await context.measure("run token ledger row", () =>
    pollUntil(
      { initialIntervalMs: 50, maxIntervalMs: 400, timeoutMs: 15_000 },
      async (): Promise<AuditEvent | null> => {
        const listed = await context.account.audit.list({ limit: 500 });

        return (
          listed.events.find(
            (event: AuditEvent): boolean =>
              event.action === "run.completed" &&
              event.actor.agentId === own.agentId,
          ) ?? null
        );
      },
    ),
  );
  const [asker, holder] = row?.actor.chain ?? [];
  assertStep(
    "the ledger records the token holder as the delegating agent, without the display name",
    row?.actor.chain?.length === 2 &&
      asker?.kind === "user" &&
      asker.id === "U1" &&
      asker.name === undefined &&
      holder?.kind === "agent" &&
      holder.agentId === own.agentId,
    JSON.stringify(row?.actor ?? null),
  );
}
