import { afterAll, describe, expect, it, spyOn } from "bun:test";
import {
  channelPolicyIdentity,
  createPolicyToolApproval,
  evaluateChannelInvoke,
  policyDecisionLogMessage,
} from "../src/harness/policy.ts";
import {
  getStorage,
  setStorageForTests,
  type AuditLedgerInput,
  type Storage,
} from "../src/shared/storage.ts";
import { drainInFlight } from "../src/shared/in-flight.ts";
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

const auditWrites: AuditLedgerInput[] = [];

setStorageForTests({
  agentPolicies: {
    getById: async () => policyRecord(),
  },
  auditLedger: {
    append: async (input: AuditLedgerInput): Promise<void> => {
      auditWrites.push(input);
    },
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

afterAll(async (): Promise<void> => {
  await server.stop(true);
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
  await closed.stop(true);
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
    auditWrites.length = 0;
    seenPolicyInputs.length = 0;
    const principal = {
      kind: "agent" as const,
      accountId: "acct_1",
      agentId: "agent_1",
      chain: [{ kind: "user" as const, id: "U1", channel: "slack" }],
    };
    const approval = await createPolicyToolApproval(
      agentConfig(),
      { accountId: "acct_1", agentId: "agent_1", principal: principal },
      [],
    );
    expect(approval).toBeDefined();
    const status = await approval!(toolCallEvent);
    expect(decisionType(status)).toBe("denied");
    expect(seenPolicyInputs[0]).toMatchObject({ principal: principal });
    // An enforced denial is an audit-ledger event, and never carries the tool input.
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({
      accountId: "acct_1",
      agentId: "agent_1",
      chain: principal.chain,
      action: "tool.denied",
      resource: { kind: "tool", name: "bash" },
      details: {
        action: "workspace.exec",
        toolCallId: "call_1",
        reason: "Denied by policy rule deny-bash",
      },
    });
    expect(JSON.stringify(auditWrites[0])).not.toContain("rm -rf");
  });

  it("drains an enforced denial's audit write before shutdown", async (): Promise<void> => {
    const release = Promise.withResolvers<void>();
    const append = spyOn(getStorage().auditLedger, "append").mockImplementation(
      async (): Promise<void> => {
        await release.promise;
      },
    );
    let drained = false;
    let draining: Promise<void> | undefined;
    try {
      const approval = await createPolicyToolApproval(
        agentConfig(),
        { accountId: "acct_1", agentId: "agent_1" },
        [],
      );
      expect(decisionType(await approval!(toolCallEvent))).toBe("denied");
      draining = drainInFlight().then((): void => {
        drained = true;
      });
      await Bun.sleep(0);
      expect(drained).toBe(false);
    } finally {
      release.resolve();
      await draining;
      append.mockRestore();
    }
    expect(drained).toBe(true);
  });

  // The rego downgrades an auditing policy; the harness passes that verdict straight through.
  it("approves the verdict an auditing policy produced", async () => {
    auditWrites.length = 0;
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
      expect(auditWrites).toHaveLength(0);
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

  // The mode comes from the document, so an outage must not make an unpromoted policy refuse.
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

  it("omits channel identity fields that the provider did not supply", () => {
    // No identity means the roles are unknown: absent, so a negated operator cannot match.
    expect(channelPolicyIdentity(undefined)).toEqual({});
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
    // A deleted policy must not drop out of the set and silently downgrade the gates to audit.
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
    // Drive its own evaluation so the test still holds under -t or .only.
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
    await closed.stop(true);
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
