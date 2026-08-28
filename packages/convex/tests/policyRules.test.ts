/** Validation tests for the config-plane policy document rules. */

import { describe, expect, it } from "vitest";
import { normalizePolicyDocument } from "../agent/policies";
import {
  POLICY_ACTIONS,
  normalizeCreatePolicyInput,
  normalizePolicyDocument as normalizeRulesPolicyDocument,
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

// model/policyRules.ts is the single home of document validation (core
// re-exports its types). A scalar value satisfies no rego in/notIn branch, so
// the condition never fires and a deny silently does nothing — refuse it at
// write time.
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

  it("carries the mode on the policy document", () => {
    expect(
      normalizeRulesPolicyDocument({ version: 1, mode: "enforce", rules: [] }),
    ).toEqual({ version: 1, mode: "enforce", rules: [] });
    expect(normalizeRulesPolicyDocument({ version: 1, rules: [] })).toEqual({
      version: 1,
      rules: [],
    });
    expect(() =>
      normalizeRulesPolicyDocument({ version: 1, mode: "watch", rules: [] }),
    ).toThrow("policy document mode");
  });

  it("rejects unknown resource selector keys", () => {
    expect(() =>
      normalizeRulesPolicyDocument({
        version: 1,
        rules: [
          {
            effect: "deny",
            actions: ["workspace.exec"],
            resources: { toolName: ["bash"] },
          },
        ],
      }),
    ).toThrow("policy rules[0].resources.toolName is not supported");
  });

  it("rejects heterogeneous condition value arrays", () => {
    const documentWithValue = (value: unknown) => ({
      version: 1,
      rules: [
        {
          effect: "deny",
          actions: ["tool.call"],
          conditions: [{ attribute: "stage", operator: "in", value: value }],
        },
      ],
    });
    expect(() =>
      normalizeRulesPolicyDocument(documentWithValue(["prod", 1, true])),
    ).toThrow("policy rules[0].conditions[0].value is invalid");
    expect(() =>
      normalizeRulesPolicyDocument(documentWithValue(["prod", "staging"])),
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
