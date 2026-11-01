import {
  apiActionForRequest,
  authorize,
  type ApiPrincipal,
  type ApiResource,
} from "../../packages/convex/model/apiAuthorization.ts";
import type {
  PolicyDocument,
  PolicyRule,
} from "../../packages/convex/model/policyRules.ts";
import type { BenchCase } from "../runner.ts";

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

// A resource off the role's pin is refused before any rule is read, so every resource carries it.
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
    // No rule grants policies:write: every rule is walked, the worst case an attacker drives.
    run: (): unknown => {
      return authorize(
        PRINCIPAL,
        apiActionForRequest("POST", "policies"),
        OWN_POLICY,
      );
    },
  },
];
