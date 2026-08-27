/** Validation tests for the config-plane policy document rules. */

import { describe, expect, it } from "vitest";
import { normalizePolicyDocument } from "../agent/policies";
import {
  POLICY_ACTIONS,
  normalizeCreatePolicyInput,
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
          { attribute: "userRoles", operator: operator, value: value },
        ],
      },
    ],
  },
});

// This file mirrors apps/core/src/shared/domain/policy.ts. A scalar value
// satisfies no rego in/notIn branch, so the condition never fires and a deny
// silently does nothing — both copies must refuse it at write time.
describe("normalizeCreatePolicyInput", () => {
  it("rejects a scalar value for in and notIn", () => {
    expect(() =>
      normalizeCreatePolicyInput(policyWith("notIn", "oncall")),
    ).toThrow("must be an array when operator is notIn");
    expect(() =>
      normalizeCreatePolicyInput(policyWith("in", "oncall")),
    ).toThrow("must be an array when operator is in");
  });

  it("accepts an array value, and a scalar on a scalar operator", () => {
    expect(() =>
      normalizeCreatePolicyInput(policyWith("notIn", ["oncall"])),
    ).not.toThrow();
    expect(() =>
      normalizeCreatePolicyInput(policyWith("equals", "oncall")),
    ).not.toThrow();
  });
});

// `broods dev` writes through normalizePolicyDocument while the CRUD routes go
// through the normalizer above. A drift between them makes a rule deployable by
// one path and rejected by the other.
describe("normalizePolicyDocument", () => {
  it("accepts every action the CRUD normalizer accepts", () => {
    for (const action of POLICY_ACTIONS) {
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
