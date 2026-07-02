/**
 * Enforce-mode wiring for OPA-backed agent policy: createPolicyToolApproval
 * must act on denials when config.policy.mode is "enforce", stay shadow-only
 * in "audit", and authenticate against the OPA endpoint with OPA_API_TOKEN.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createPolicyToolApproval } from "../functions/harness-processing/policy.ts";
import { setStorageForTests, type StorageProvider } from "../functions/_shared/storage/index.ts";

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
} as unknown as StorageProvider);

const seenAuthHeaders: Array<string | null> = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    seenAuthHeaders.push(request.headers.get("authorization"));
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
      enabled: true,
      policyIds: ["policy_a"],
      ...(mode ? { mode } : {}),
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
  if (status && typeof status === "object") return (status as { type?: string }).type;
  return undefined;
}

describe("agent policy enforce mode", () => {
  it("blocks denied tool calls when mode is enforce", async () => {
    const approval = await createPolicyToolApproval(agentConfig("enforce"), { accountId: "acct_1", agentId: "agent_1" }, []);
    expect(approval).toBeDefined();
    const status = await approval!(toolCallEvent);
    expect(decisionType(status)).toBe("denied");
  });

  it("approves despite denials when mode is audit (default)", async () => {
    for (const config of [agentConfig("audit"), agentConfig()]) {
      const approval = await createPolicyToolApproval(config, { accountId: "acct_1", agentId: "agent_1" }, []);
      expect(approval).toBeDefined();
      const status = await approval!(toolCallEvent);
      expect(decisionType(status)).toBe("approved");
    }
  });

  it("sends the OPA_API_TOKEN bearer header on evaluations", () => {
    expect(seenAuthHeaders.length).toBeGreaterThan(0);
    expect(seenAuthHeaders).toEqual(seenAuthHeaders.map(() => "Bearer test-opa-token"));
  });
});
