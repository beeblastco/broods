/** Validation tests for the config-plane policy document rules. */

import { describe, expect, it } from "vitest";
import {
  normalizeCreatePolicyInput,
  normalizePolicyDocument,
} from "../model/policyRules";

const policyWith = (
  operator: string,
  value: unknown,
): Record<string, unknown> => ({
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
// the condition never fires and a deny silently does nothing. Refuse it at
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
      normalizePolicyDocument({ version: 1, mode: "enforce", rules: [] }),
    ).toEqual({ version: 1, mode: "enforce", rules: [] });
    expect(normalizePolicyDocument({ version: 1, rules: [] })).toEqual({
      version: 1,
      rules: [],
    });
    expect(() =>
      normalizePolicyDocument({ version: 1, mode: "watch", rules: [] }),
    ).toThrow("policy document mode");
  });

  it("rejects unknown resource selector keys", () => {
    expect(() =>
      normalizePolicyDocument({
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

  it("accepts the mcpIds selector on tool.call rules", () => {
    expect(
      normalizePolicyDocument({
        version: 1,
        rules: [
          {
            id: "r-mcp",
            effect: "deny",
            actions: ["tool.call"],
            resources: { mcpIds: ["k57e2abc123def456ghi"] },
          },
        ],
      }),
    ).toEqual({
      version: 1,
      rules: [
        {
          id: "r-mcp",
          effect: "deny",
          actions: ["tool.call"],
          resources: { mcpIds: ["k57e2abc123def456ghi"] },
        },
      ],
    });
  });

  it("rejects heterogeneous condition value arrays", () => {
    const documentWithValue = (value: unknown): Record<string, unknown> => ({
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
      normalizePolicyDocument(documentWithValue(["prod", 1, true])),
    ).toThrow("policy rules[0].conditions[0].value is invalid");
    expect(() =>
      normalizePolicyDocument(documentWithValue(["prod", "staging"])),
    ).not.toThrow();
  });
});
