/** Validation tests for the config-plane policy document rules. */

import { describe, expect, it } from "vitest";
import { normalizeCreateAgentPolicyInput } from "../model/policyRules";

const policyWith = (operator: string, value: unknown) => ({
  name: "p1",
  document: {
    version: 1,
    rules: [
      {
        effect: "deny",
        actions: ["agent.invoke"],
        conditions: [{ attribute: "actorRoles", operator: operator, value: value }],
      },
    ],
  },
});

// This file mirrors apps/core/src/shared/domain/agent-policy.ts. A scalar value
// satisfies no rego in/notIn branch, so the condition never fires and a deny
// silently does nothing — both copies must refuse it at write time.
describe("normalizeCreateAgentPolicyInput", () => {
  it("rejects a scalar value for in and notIn", () => {
    expect(() => normalizeCreateAgentPolicyInput(policyWith("notIn", "oncall"))).toThrow(
      "must be an array when operator is notIn",
    );
    expect(() => normalizeCreateAgentPolicyInput(policyWith("in", "oncall"))).toThrow(
      "must be an array when operator is in",
    );
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
