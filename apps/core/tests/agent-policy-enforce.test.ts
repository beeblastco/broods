/**
 * Enforce-mode wiring for OPA-backed agent policy: createPolicyToolApproval
 * must act on denials when config.policy.mode is "enforce", stay shadow-only
 * in "audit", and authenticate against the OPA endpoint with OPA_API_TOKEN.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  channelPolicyIdentity,
  createPolicyToolApproval,
  evaluateChannelInvoke,
  policyDecisionLogMessage,
} from "../src/harness/policy.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";

const policyRecord = {
  accountId: "acct_1",
  policyId: "policy_a",
  name: "deny-exec",
  document: {
    version: 1,
    rules: [{ id: "deny-bash", effect: "deny", actions: ["workspace.exec"] }],
  },
  status: "active",
  createdAt: "2026-07-02T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
};

setStorageForTests({
  agentPolicies: {
    getById: async () => policyRecord,
  },
} as unknown as Storage);

const seenAuthHeaders: Array<string | null> = [];
const seenPolicyInputs: unknown[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async function(request) {
    seenAuthHeaders.push(request.headers.get("authorization"));
    const body = await request.json().catch(() => undefined);
    seenPolicyInputs.push(
      body && typeof body === "object" && "input" in body
        ? (body as { input?: unknown }).input
        : body,
    );

    return Response.json({
      result: {
        allow: false,
        allowed: false,
        mode: "enforce",
        reason: "Denied by policy rule deny-bash",
        matchedRuleIds: ["deny-bash"],
      },
    });
  },
});

process.env.OPA_BASE_URL = `http://127.0.0.1:${server.port}`;
process.env.OPA_API_TOKEN = "test-opa-token";

afterAll(() => {
  server.stop(true);
  setStorageForTests(null);
  delete process.env.OPA_BASE_URL;
  delete process.env.OPA_API_TOKEN;
});

function agentConfig(mode?: "enforce" | "audit") {
  return {
    policy: {
      policyIds: ["policy_a"],
      ...(mode ? { mode: mode } : {}),
    },
  } as Parameters<typeof createPolicyToolApproval>[0];
}

const toolCallEvent = {
  toolCall: {
    toolName: "bash",
    toolCallId: "call_1",
    input: { command: "rm -rf /" },
  },
  messages: [],
} as never;

function decisionType(status: unknown): string | undefined {
  if (typeof status === "string") return status;
  if (status && typeof status === "object")
    return (status as { type?: string }).type;

  return undefined;
}

describe("agent policy enforce mode", () => {
  it("formats policy warnings with enough detail for the dashboard log row", () => {
    expect(
      policyDecisionLogMessage({
        action: "workspace.exec",
        decision: "approved",
        enforced: false,
        inputPreview: 'command="whoami"',
        mode: "audit",
        reason: "Allowed by policy rule allow-bash",
        toolName: "bash",
      }),
    ).toBe(
      'Agent policy approved bash (audit): action workspace.exec, input command="whoami": Allowed by policy rule allow-bash',
    );

    expect(
      policyDecisionLogMessage({
        action: "workspace.exec",
        decision: "denied",
        enforced: false,
        inputPreview: 'command="rm -rf /"',
        mode: "audit",
        reason: "Denied by policy rule deny-bash",
        toolName: "bash",
      }),
    ).toBe(
      'Agent policy would deny bash (audit): action workspace.exec, input command="rm -rf /": Denied by policy rule deny-bash',
    );

    expect(
      policyDecisionLogMessage({
        action: "workspace.exec",
        decision: "denied",
        enforced: true,
        inputPreview: 'command="rm -rf /"',
        mode: "enforce",
        reason: "Denied by policy rule deny-bash",
        toolName: "bash",
      }),
    ).toBe(
      'Agent policy denied bash (enforce): action workspace.exec, input command="rm -rf /": Denied by policy rule deny-bash',
    );
  });

  it("blocks denied tool calls when mode is enforce", async () => {
    const approval = await createPolicyToolApproval(
      agentConfig("enforce"),
      { accountId: "acct_1", agentId: "agent_1" },
      [],
    );
    expect(approval).toBeDefined();
    const status = await approval!(toolCallEvent);
    expect(decisionType(status)).toBe("denied");
  });

  it("approves despite denials when mode is audit (default)", async () => {
    for (const config of [agentConfig("audit"), agentConfig()]) {
      const approval = await createPolicyToolApproval(
        config,
        { accountId: "acct_1", agentId: "agent_1" },
        [],
      );
      expect(approval).toBeDefined();
      const status = await approval!(toolCallEvent);
      expect(decisionType(status)).toBe("approved");
    }
  });

  it("fails closed in enforce mode when OPA is unreachable", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const closedPort = closed.port;
    closed.stop(true);
    const previous = process.env.OPA_BASE_URL;
    process.env.OPA_BASE_URL = `http://127.0.0.1:${closedPort}`;
    try {
      const approval = await createPolicyToolApproval(
        agentConfig("enforce"),
        { accountId: "acct_1", agentId: "agent_1" },
        [],
      );
      expect(approval).toBeDefined();
      const status = await approval!(toolCallEvent);
      expect(decisionType(status)).toBe("denied");
    } finally {
      process.env.OPA_BASE_URL = previous;
    }
  });

  it("sends the OPA_API_TOKEN bearer header on evaluations", () => {
    expect(seenAuthHeaders.length).toBeGreaterThan(0);
    expect(seenAuthHeaders).toEqual(
      seenAuthHeaders.map(() => "Bearer test-opa-token"),
    );
  });

  it("sends tool identity and parameter details to OPA", () => {
    expect(seenPolicyInputs).toContainEqual(
      expect.objectContaining({
        action: "workspace.exec",
        toolName: "bash",
        tool: expect.objectContaining({
          input: { command: "rm -rf /" },
          inputKeys: ["command"],
          inputPreview: 'command="rm -rf /"',
        }),
      }),
    );
  });

  it("carries the channel place and person onto the policy input", async () => {
    const approval = await createPolicyToolApproval(
      agentConfig("audit"),
      {
        accountId: "acct_1",
        agentId: "agent_1",
        channel: "slack",
        ...channelPolicyIdentity({
          workspaceRef: "T09BEEB",
          channelId: "C042PRODENG",
          threadId: "1753264860.4471",
          actorId: "U777",
          actorName: "Ana",
        }),
      },
      [],
    );
    await approval!(toolCallEvent);

    // The rego resolves any dotted path on input, so a rule can already say
    // "deny unless input.channelId is C042OPS" with no policy-engine change.
    expect(seenPolicyInputs).toContainEqual(
      expect.objectContaining({
        channel: "slack",
        channelId: "C042PRODENG",
        threadId: "1753264860.4471",
        actorId: "U777",
        actorName: "Ana",
      }),
    );
  });

  it("omits channel identity fields that the provider did not supply", () => {
    expect(channelPolicyIdentity(undefined)).toEqual({});
    expect(channelPolicyIdentity({ channelId: "C1" })).toEqual({
      channelId: "C1",
    });
    expect(
      channelPolicyIdentity({ actorId: "U1", actorRoles: ["oncall"] }),
    ).toEqual({ actorId: "U1", actorRoles: ["oncall"] });
    // An empty role list is noise on the policy input, not a value to match on.
    expect(channelPolicyIdentity({ actorId: "U1", actorRoles: [] })).toEqual({
      actorId: "U1",
    });
  });
});

describe("agent.invoke gate", () => {
  it("refuses the tag in enforce mode and reports the rule that denied it", async () => {
    const decision = await evaluateChannelInvoke(agentConfig("enforce"), {
      accountId: "acct_1",
      agentId: "agent_1",
      channel: "slack",
      channelId: "C042GENERAL",
      actorId: "U777",
    });

    expect(decision).toEqual({
      allowed: false,
      mode: "enforce",
      reason: "Denied by policy rule deny-bash",
      matchedRuleIds: ["deny-bash"],
    });
  });

  it("records the same denial without blocking in audit mode", async () => {
    const decision = await evaluateChannelInvoke(agentConfig("audit"), {
      accountId: "acct_1",
      agentId: "agent_1",
      channel: "slack",
    });

    expect(decision?.mode).toBe("audit");
    expect(decision?.allowed).toBe(false);
  });

  it("stays out of the way when the agent has no policies assigned", async () => {
    expect(
      await evaluateChannelInvoke(
        {},
        { accountId: "acct_1", agentId: "agent_1" },
      ),
    ).toBeUndefined();
  });

  it("sends the actor and channel to OPA as agent.invoke", async () => {
    // Drive its own evaluation: asserting on a sibling test's recorded input
    // passes only when that test ran first, and breaks under -t or .only.
    await evaluateChannelInvoke(agentConfig("enforce"), {
      accountId: "acct_1",
      agentId: "agent_1",
      channel: "slack",
      channelId: "C042GENERAL",
      actorId: "U777",
    });

    expect(seenPolicyInputs).toContainEqual(
      expect.objectContaining({
        action: "agent.invoke",
        channel: "slack",
        channelId: "C042GENERAL",
        actorId: "U777",
      }),
    );
  });

  it("fails closed when OPA is unreachable", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const closedPort = closed.port;
    closed.stop(true);
    const previous = process.env.OPA_BASE_URL;
    process.env.OPA_BASE_URL = `http://127.0.0.1:${closedPort}`;
    try {
      const decision = await evaluateChannelInvoke(agentConfig("enforce"), {
        accountId: "acct_1",
        agentId: "agent_1",
      });

      expect(decision?.allowed).toBe(false);
      expect(decision?.reason).toBe("Policy evaluation failed");
    } finally {
      process.env.OPA_BASE_URL = previous;
    }
  });
});
