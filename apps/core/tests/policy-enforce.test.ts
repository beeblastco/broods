/**
 * Enforcement wiring for OPA-backed policy. Mode rides on the policy document,
 * and the rego applies it, so the harness acts on the verdict it is given. What
 * is left to check here is the OPA-unreachable path, which must fail closed only
 * where something actually enforces, plus OPA_API_TOKEN authentication.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  channelPolicyIdentity,
  createPolicyToolApproval,
  evaluateChannelInvoke,
  policyDecisionLogMessage,
} from "../src/harness/policy.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";

let policyMode: "enforce" | "audit" = "enforce";

function policyRecord() {
  return {
    accountId: "acct_1",
    policyId: "policy_a",
    name: "deny-exec",
    document: {
      version: 1,
      mode: policyMode,
      rules: [{ id: "deny-bash", effect: "deny", actions: ["workspace.exec"] }],
    },
    status: "active",
    createdAt: "2026-07-02T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
  };
}

setStorageForTests({
  agentPolicies: {
    getById: async () => policyRecord(),
  },
} as unknown as Storage);

const ENFORCED_DENIAL = {
  allow: false,
  allowed: false,
  mode: "enforce",
  reason: "Denied by policy rule deny-bash",
  matchedRuleIds: ["deny-bash"],
  auditedRuleIds: [],
};

// Stands in for what the rego returns once it has applied the policy's mode.
let opaResult: Record<string, unknown> | undefined = ENFORCED_DENIAL;

const seenAuthHeaders: Array<string | null> = [];
const seenPolicyInputs: unknown[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async function (request) {
    seenAuthHeaders.push(request.headers.get("authorization"));
    const body = await request.json().catch(() => undefined);
    seenPolicyInputs.push(
      body && typeof body === "object" && "input" in body
        ? (body as { input?: unknown }).input
        : body,
    );

    return Response.json({ result: opaResult });
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

function agentConfig(): AgentConfig {
  return {
    policies: ["policy_a"],
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

async function withUnreachableOpa(run: () => Promise<void>): Promise<void> {
  const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
  const closedPort = closed.port;
  closed.stop(true);
  const previous = process.env.OPA_BASE_URL;
  process.env.OPA_BASE_URL = `http://127.0.0.1:${closedPort}`;
  try {
    await run();
  } finally {
    process.env.OPA_BASE_URL = previous;
  }
}

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

  it("acts on a denial the policy engine returned", async () => {
    const approval = await createPolicyToolApproval(
      agentConfig(),
      { accountId: "acct_1", agentId: "agent_1" },
      [],
    );
    expect(approval).toBeDefined();
    const status = await approval!(toolCallEvent);
    expect(decisionType(status)).toBe("denied");
  });

  // An auditing policy is downgraded by the rego, not here: the harness must
  // pass that verdict straight through rather than second-guessing it.
  it("approves the verdict an auditing policy produced", async () => {
    policyMode = "audit";
    opaResult = {
      allow: true,
      allowed: true,
      mode: "audit",
      reason:
        "Audited by policy rule deny-bash: would deny, policy is not enforcing",
      matchedRuleIds: [],
      auditedRuleIds: ["deny-bash"],
    };
    try {
      const approval = await createPolicyToolApproval(
        agentConfig(),
        { accountId: "acct_1", agentId: "agent_1" },
        [],
      );
      expect(approval).toBeDefined();
      const status = await approval!(toolCallEvent);
      expect(decisionType(status)).toBe("approved");
    } finally {
      policyMode = "enforce";
      opaResult = ENFORCED_DENIAL;
    }
  });

  it("fails closed when OPA is unreachable and a policy enforces", async () => {
    await withUnreachableOpa(async () => {
      const approval = await createPolicyToolApproval(
        agentConfig(),
        { accountId: "acct_1", agentId: "agent_1" },
        [],
      );
      expect(approval).toBeDefined();
      expect(decisionType(await approval!(toolCallEvent))).toBe("denied");
    });
  });

  // The mode lives in a document this path did read, so an outage must not turn
  // a policy nobody has promoted yet into one that refuses.
  it("stays open when OPA is unreachable and nothing enforces", async () => {
    policyMode = "audit";
    try {
      await withUnreachableOpa(async () => {
        const approval = await createPolicyToolApproval(
          agentConfig(),
          { accountId: "acct_1", agentId: "agent_1" },
          [],
        );
        expect(approval).toBeDefined();
        expect(decisionType(await approval!(toolCallEvent))).toBe("approved");
      });
    } finally {
      policyMode = "enforce";
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
      agentConfig(),
      {
        accountId: "acct_1",
        agentId: "agent_1",
        channel: "slack",
        ...channelPolicyIdentity({
          workspaceRef: "T09BEEB",
          channelId: "C042PRODENG",
          threadId: "1753264860.4471",
          userId: "U777",
          userName: "Ana",
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
        userId: "U777",
        userName: "Ana",
      }),
    );
  });

  it("omits channel identity fields that the provider did not supply, except userRoles", () => {
    expect(channelPolicyIdentity(undefined)).toEqual({ userRoles: [] });
    expect(channelPolicyIdentity({ channelId: "C1" })).toEqual({
      channelId: "C1",
      userRoles: [],
    });
    expect(
      channelPolicyIdentity({ userId: "U1", userRoles: ["oncall"] }),
    ).toEqual({ userId: "U1", userRoles: ["oncall"] });
    // A user with no tag role still has to match a `userRoles notIn` rule.
    expect(channelPolicyIdentity({ userId: "U1", userRoles: [] })).toEqual({
      userId: "U1",
      userRoles: [],
    });
  });
});

describe("agent.invoke gate", () => {
  it("refuses the tag in enforce mode and reports the rule that denied it", async () => {
    const decision = await evaluateChannelInvoke(agentConfig(), {
      accountId: "acct_1",
      agentId: "agent_1",
      channel: "slack",
      channelId: "C042GENERAL",
      userId: "U777",
    });

    expect(decision).toEqual({
      allowed: false,
      mode: "enforce",
      reason: "Denied by policy rule deny-bash",
      matchedRuleIds: ["deny-bash"],
      auditedRuleIds: [],
    });
  });

  // The same rule, from a policy nobody promoted: reported, and let through.
  it("reports an audited denial and still admits the turn", async () => {
    policyMode = "audit";
    opaResult = {
      allow: true,
      allowed: true,
      mode: "audit",
      reason:
        "Audited by policy rule deny-bash: would deny, policy is not enforcing",
      matchedRuleIds: [],
      auditedRuleIds: ["deny-bash"],
    };
    try {
      const decision = await evaluateChannelInvoke(agentConfig(), {
        accountId: "acct_1",
        agentId: "agent_1",
        channel: "slack",
      });

      expect(decision?.mode).toBe("audit");
      expect(decision?.allowed).toBe(true);
      expect(decision?.auditedRuleIds).toEqual(["deny-bash"]);
    } finally {
      policyMode = "enforce";
      opaResult = ENFORCED_DENIAL;
    }
  });

  it("stays out of the way when the agent has no policies assigned", async () => {
    expect(
      await evaluateChannelInvoke(
        {},
        { accountId: "acct_1", agentId: "agent_1" },
      ),
    ).toBeUndefined();
  });

  it("sends a deny-all document for a policy that resolves to nothing", async (): Promise<void> => {
    // A deleted policy used to vanish from the set. If it was the only
    // enforcing one, both gates dropped to audit and let everything through.
    setStorageForTests({
      agentPolicies: { getById: async (): Promise<null> => null },
    } as unknown as Storage);
    try {
      const decision = await evaluateChannelInvoke(agentConfig(), {
        accountId: "acct_1",
        agentId: "agent_1",
        channel: "zalo",
      });

      expect(decision?.allowed).toBe(false);
      expect(decision?.mode).toBe("enforce");
      expect(seenPolicyInputs.at(-1)).toEqual(
        expect.objectContaining({
          action: "agent.invoke",
          policies: [
            expect.objectContaining({
              mode: "enforce",
              rules: [expect.objectContaining({ id: "unresolved-policy" })],
            }),
          ],
        }),
      );
    } finally {
      setStorageForTests({
        agentPolicies: { getById: async () => policyRecord() },
      } as unknown as Storage);
    }
  });

  it("sends the actor and channel to OPA as agent.invoke", async () => {
    // Drive its own evaluation: asserting on a sibling test's recorded input
    // passes only when that test ran first, and breaks under -t or .only.
    await evaluateChannelInvoke(agentConfig(), {
      accountId: "acct_1",
      agentId: "agent_1",
      channel: "slack",
      channelId: "C042GENERAL",
      userId: "U777",
    });

    expect(seenPolicyInputs).toContainEqual(
      expect.objectContaining({
        action: "agent.invoke",
        channel: "slack",
        channelId: "C042GENERAL",
        userId: "U777",
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
      const decision = await evaluateChannelInvoke(agentConfig(), {
        accountId: "acct_1",
        agentId: "agent_1",
      });

      expect(decision?.allowed).toBe(false);
      expect(decision?.reason).toBe("Policy evaluation failed");
    } finally {
      process.env.OPA_BASE_URL = previous;
    }
  });

  it("stays open through an OPA outage when nothing enforces", async (): Promise<void> => {
    policyMode = "audit";
    try {
      await withUnreachableOpa(async (): Promise<void> => {
        const decision = await evaluateChannelInvoke(agentConfig(), {
          accountId: "acct_1",
          agentId: "agent_1",
        });

        expect(decision?.allowed).toBe(true);
        expect(decision?.mode).toBe("audit");
        expect(decision?.reason).toBe("Policy evaluation failed");
      });
    } finally {
      policyMode = "enforce";
    }
  });

  it("opens on an absent decision only when nothing enforces", async (): Promise<void> => {
    opaResult = undefined;
    try {
      const enforced = await evaluateChannelInvoke(agentConfig(), {
        accountId: "acct_1",
        agentId: "agent_1",
      });
      policyMode = "audit";
      const audited = await evaluateChannelInvoke(agentConfig(), {
        accountId: "acct_1",
        agentId: "agent_1",
      });

      expect(enforced?.allowed).toBe(false);
      expect(enforced?.mode).toBe("enforce");
      expect(audited?.allowed).toBe(true);
      expect(audited?.mode).toBe("audit");
    } finally {
      policyMode = "enforce";
      opaResult = ENFORCED_DENIAL;
    }
  });
});
