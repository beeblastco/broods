/**
 * The config-plane authorization decision. Every bsts_ request through the
 * gateway resolves to a role and runs `authorize` before anything else, and a
 * default-deny walks the entire rule list, so the miss, not the hit, is the
 * case worth holding a baseline on.
 */

import {
  apiActionForRequest,
  authorize,
  type ApiPrincipal,
  type ApiResource,
} from "../../packages/convex/model/apiAuthorization.ts";
import type {
  ApiPolicyAction,
  PolicyDocument,
  PolicyRule,
} from "../../packages/convex/model/policyRules.ts";
import type { BenchCase } from "../runner.ts";

// A role a platform team would actually write: broad reads, scoped writes, one
// explicit deny that has to be reached before an allow can be trusted.
const POLICY_RULES: readonly PolicyRule[] = [
  {
    id: "read-everything",
    effect: "allow",
    actions: [
      "account:read",
      "agents:read",
      "channels:read",
      "crons:read",
      "env:read",
      "hooks:read",
      "mcp:read",
      "policies:read",
      "sandboxes:read",
      "skills:read",
      "workspaces:read",
    ],
  },
  {
    id: "write-owned-agents",
    effect: "allow",
    actions: ["agents:write"],
    resources: {
      resourceIds: ["agt_7f3c9d21", "agt_1b4e8a02", "agt_c93d5f77"],
    },
  },
  {
    id: "write-skills-and-mcp",
    effect: "allow",
    actions: ["skills:write", "mcp:write"],
    resources: { resourceIds: ["*"] },
  },
  {
    id: "write-crons",
    effect: "allow",
    actions: ["crons:write"],
    resources: { resourceIds: ["cron_nightly", "cron_hourly"] },
  },
  {
    id: "deny-production-env",
    effect: "deny",
    actions: ["env:write"],
    resources: { resourceIds: ["STRIPE_SECRET_KEY", "ANTHROPIC_API_KEY"] },
  },
  {
    id: "write-workspaces",
    effect: "allow",
    actions: ["workspaces:write"],
    resources: { resourceIds: ["ws_main"] },
  },
];

const POLICY: PolicyDocument = {
  version: 1,
  mode: "enforce",
  rules: [...POLICY_RULES],
};

// The stage the role is pinned to. A resource off the pin is refused before any
// rule is read, so both the role and every resource it is asked about carry it.
const PIN = { projectId: "prj_acme", stageId: "stg_production" };

const PRINCIPAL: ApiPrincipal = {
  kind: "role",
  accountId: "acc_5f21c9",
  roleId: "brole_8c1d4a9e",
  policy: POLICY,
  ...PIN,
};

const OWN_AGENT: ApiResource = { type: "agents", id: "agt_c93d5f77", ...PIN };
const OWN_POLICY: ApiResource = {
  type: "policies",
  id: "pol_guardrails",
  ...PIN,
};

export const configPlaneAuthzCases: readonly BenchCase[] = [
  {
    name: "convex/api-authorize-allow",
    iterations: 200_000,
    setup: (): void => {
      expectDecision(
        apiActionForRequest("PATCH", "agents"),
        OWN_AGENT,
        "allowed by rule write-owned-agents",
      );
    },
    run: (): unknown => {
      return authorize(
        PRINCIPAL,
        apiActionForRequest("PATCH", "agents"),
        OWN_AGENT,
      );
    },
  },
  {
    name: "convex/api-authorize-default-deny",
    iterations: 200_000,
    // No rule grants policies:write, so this walks every rule and falls through
    // to the default deny: the worst case, and the one an attacker drives.
    setup: (): void => {
      expectDecision(
        apiActionForRequest("POST", "policies"),
        OWN_POLICY,
        "no rule allows policies:write",
      );
    },
    run: (): unknown => {
      return authorize(
        PRINCIPAL,
        apiActionForRequest("POST", "policies"),
        OWN_POLICY,
      );
    },
  },
];

/**
 * Fails a case's setup when it no longer reaches the decision it exists to
 * time, so a fixture that drifts off the measured path stops the run instead
 * of reporting a faster number for different work.
 */
function expectDecision(
  action: ApiPolicyAction,
  resource: ApiResource,
  reason: string,
): void {
  const decision = authorize(PRINCIPAL, action, resource);
  if (decision.reason !== reason) {
    throw new Error(
      `authorize bench fixture: expected "${reason}", got "${decision.reason}"`,
    );
  }
}
