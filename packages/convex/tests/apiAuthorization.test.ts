/**
 * Unit tests for the API authorization decision contract: default deny,
 * allow rules, deny precedence, resource-id selectors, and the HTTP
 * method-to-action mapping.
 */

import { describe, expect, test } from "vitest";
import {
  apiActionForRequest,
  authorize,
  type ApiPrincipal,
} from "../model/apiAuthorization";
import type { PolicyDocument } from "../model/policyRules";

function principalWith(policy: PolicyDocument): ApiPrincipal {
  return {
    kind: "role",
    accountId: "account-1",
    roleId: "fp_role_test",
    policy: policy,
  };
}

describe("apiActionForRequest", () => {
  test("maps GET and HEAD to read, everything else to write", () => {
    expect(apiActionForRequest("GET", "agents")).toBe("agents:read");
    expect(apiActionForRequest("HEAD", "agents")).toBe("agents:read");
    expect(apiActionForRequest("POST", "crons")).toBe("crons:write");
    expect(apiActionForRequest("PATCH", "agents")).toBe("agents:write");
    expect(apiActionForRequest("DELETE", "skills")).toBe("skills:write");
  });
});

describe("authorize", () => {
  test("default-denies when no rule matches", () => {
    const decision = authorize(
      principalWith({ version: 1, rules: [] }),
      "agents:read",
      { type: "agents" },
    );
    expect(decision.allow).toBe(false);
    expect(decision.matchedRuleIds).toEqual([]);
  });

  test("allows an action granted by an allow rule", () => {
    const decision = authorize(
      principalWith({
        version: 1,
        rules: [{ id: "r1", effect: "allow", actions: ["agents:read"] }],
      }),
      "agents:read",
      { type: "agents" },
    );
    expect(decision.allow).toBe(true);
    expect(decision.matchedRuleIds).toEqual(["r1"]);
  });

  test("denies an action the policy never mentions", () => {
    const decision = authorize(
      principalWith({
        version: 1,
        rules: [{ id: "r1", effect: "allow", actions: ["agents:read"] }],
      }),
      "agents:write",
      { type: "agents" },
    );
    expect(decision.allow).toBe(false);
  });

  test("a matching deny beats a matching allow", () => {
    const decision = authorize(
      principalWith({
        version: 1,
        rules: [
          {
            id: "allow-all",
            effect: "allow",
            actions: ["crons:read", "crons:write"],
          },
          { id: "deny-write", effect: "deny", actions: ["crons:write"] },
        ],
      }),
      "crons:write",
      { type: "crons" },
    );
    expect(decision.allow).toBe(false);
    expect(decision.matchedRuleIds).toEqual(["deny-write"]);
  });

  test("resourceIds selectors scope a rule to named resources", () => {
    const principal = principalWith({
      version: 1,
      rules: [
        {
          id: "one-agent",
          effect: "allow",
          actions: ["agents:write"],
          resources: { resourceIds: ["agent-1"] },
        },
      ],
    });
    expect(
      authorize(principal, "agents:write", { type: "agents", id: "agent-1" })
        .allow,
    ).toBe(true);
    expect(
      authorize(principal, "agents:write", { type: "agents", id: "agent-2" })
        .allow,
    ).toBe(false);
    // The collection route carries no id, so an id-scoped rule cannot cover it.
    expect(authorize(principal, "agents:write", { type: "agents" }).allow).toBe(
      false,
    );
  });

  test("a '*' resource selector covers every id", () => {
    const principal = principalWith({
      version: 1,
      rules: [
        {
          id: "star",
          effect: "allow",
          actions: ["skills:read"],
          resources: { resourceIds: ["*"] },
        },
      ],
    });
    expect(
      authorize(principal, "skills:read", { type: "skills", id: "any" }).allow,
    ).toBe(true);
    expect(authorize(principal, "skills:read", { type: "skills" }).allow).toBe(
      true,
    );
  });
});
