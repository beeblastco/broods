/**
 * The config-plane authorization decision. Every fp_sts_ request through the
 * gateway resolves to a role and runs `authorize` before anything else, and a
 * default-deny walks the entire rule list — so the miss, not the hit, is the
 * case worth holding a baseline on.
 */

import {
  apiActionForRequest,
  authorize,
  type ApiPrincipal,
} from "../../packages/convex/model/apiAuthorization.ts";
import type {
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
      "agents:read",
      "channels:read",
      "crons:read",
      "env:read",
      "hooks:read",
      "mcp:read",
      "policies:read",
      "sandboxes:read",
      "skills:read",
      "tools:read",
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
    id: "write-skills",
    effect: "allow",
    actions: ["skills:write", "tools:write"],
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

const PRINCIPAL: ApiPrincipal = {
  kind: "role",
  accountId: "acc_5f21c9",
  roleId: "fp_role_8c1d4a9e",
  policy: POLICY,
  projectId: "prj_acme",
  stageId: "stg_production",
};

export const configPlaneAuthzCases: readonly BenchCase[] = [
  {
    name: "convex/api-authorize-allow",
    iterations: 200_000,
    run: (): unknown => {
      return authorize(PRINCIPAL, apiActionForRequest("PATCH", "agents"), {
        type: "agents",
        id: "agt_c93d5f77",
      });
    },
  },
  {
    name: "convex/api-authorize-default-deny",
    iterations: 200_000,
    // No rule grants policies:write, so this walks every rule and falls through
    // to the default deny: the worst case, and the one an attacker drives.
    run: (): unknown => {
      return authorize(PRINCIPAL, apiActionForRequest("POST", "policies"), {
        type: "policies",
        id: "pol_guardrails",
      });
    },
  },
];
