/** Validation tests for the config-plane policy document rules. */

import { describe, expect, it } from "vitest";
import { normalizePolicyDocument } from "../agentPolicies";
import {
  AGENT_POLICY_ACTIONS,
  normalizeCreateAgentPolicyInput,
} from "../model/policyRules";

const policyWith = (operator: string, value: unknown) => ({
  name: "p1",
  document: {
    version: 1,
    rules: [
      {
        effect: "deny",
        actions: ["agent.invoke"],
        conditions: [
          { attribute: "actorRoles", operator: operator, value: value },
        ],
      },
    ],
  },
});

// This file mirrors apps/core/src/shared/domain/agent-policy.ts. A scalar value
// satisfies no rego in/notIn branch, so the condition never fires and a deny
// silently does nothing — both copies must refuse it at write time.
describe("normalizeCreateAgentPolicyInput", () => {
  it("rejects a scalar value for in and notIn", () => {
    expect(() =>
      normalizeCreateAgentPolicyInput(policyWith("notIn", "oncall")),
    ).toThrow("must be an array when operator is notIn");
    expect(() =>
      normalizeCreateAgentPolicyInput(policyWith("in", "oncall")),
    ).toThrow("must be an array when operator is in");
  });

  it("accepts an array value, and a scalar on a scalar operator", () => {
    expect(() =>
      normalizeCreateAgentPolicyInput(policyWith("notIn", ["oncall"])),
    ).not.toThrow();
    expect(() =>
      normalizeCreateAgentPolicyInput(policyWith("equals", "oncall")),
    ).not.toThrow();
  });
});

// `broods dev` writes through normalizePolicyDocument while the CRUD routes go
// through the normalizer above. A drift between them makes a rule deployable by
// one path and rejected by the other.
describe("normalizePolicyDocument", () => {
  it("accepts every action the CRUD normalizer accepts", () => {
    for (const action of AGENT_POLICY_ACTIONS) {
      expect(() =>
        normalizePolicyDocument({
          version: 1,
          rules: [{ id: "r1", effect: "allow", actions: [action] }],
        }),
      ).not.toThrow();
    }
  });

  it("still refuses an action neither side defines", () => {
    expect(() =>
      normalizePolicyDocument({
        version: 1,
        rules: [{ id: "r1", effect: "allow", actions: ["workspace.delete"] }],
      }),
    ).toThrow("unsupported action");
  });
});
