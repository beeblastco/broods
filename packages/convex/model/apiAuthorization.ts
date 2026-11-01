import type {
  ApiPolicyAction,
  PolicyDocument,
  PolicyRule,
} from "./policyRules";

export type ApiResourceType = ApiPolicyAction extends `${infer T}:${string}`
  ? T
  : never;

export interface ApiAuthorizationDecision {
  allow: boolean;
  matchedRuleIds: string[];
  reason: string;
}

export interface ApiPrincipal extends RolePrincipal {
  kind: "role";
}

export interface ApiResource {
  type: ApiResourceType;
  id?: string;
  // Unset for a collection, account scope or unresolved stage: a pinned role is refused.
  projectId?: string;
  stageId?: string;
}

export interface RolePrincipal {
  accountId: string;
  roleId: string;
  policy: PolicyDocument;
  projectId?: string;
  stageId?: string;
}

export function apiActionForRequest(
  method: string,
  resourceType: ApiResourceType,
): ApiPolicyAction {
  const upper = method.toUpperCase();
  const verb = upper === "GET" || upper === "HEAD" ? "read" : "write";

  return `${resourceType}:${verb}`;
}

export function authorize(
  principal: ApiPrincipal,
  action: ApiPolicyAction,
  resource: ApiResource,
): ApiAuthorizationDecision {
  if (!withinPin(principal, resource)) {
    return {
      allow: false,
      matchedRuleIds: [],
      reason: "resource is outside the role's pinned stage",
    };
  }
  let allowing: PolicyRule | null = null;
  for (const rule of principal.policy.rules) {
    if (!ruleMatches(rule, action, resource)) continue;
    if (rule.effect === "deny") {
      return {
        allow: false,
        matchedRuleIds: [rule.id],
        reason: `denied by rule ${rule.id}`,
      };
    }
    if (!allowing) allowing = rule;
  }
  if (allowing) {
    return {
      allow: true,
      matchedRuleIds: [allowing.id],
      reason: `allowed by rule ${allowing.id}`,
    };
  }

  return {
    allow: false,
    matchedRuleIds: [],
    reason: `no rule allows ${action}`,
  };
}

export function roleDenial(
  principal: ApiPrincipal,
  method: string,
  resource: ApiResource,
): string | null {
  const action = apiActionForRequest(method, resource.type);
  const decision = authorize(principal, action, resource);

  if (decision.allow) return null;

  return withinPin(principal, resource)
    ? `Role is not allowed to ${action}`
    : `Role is pinned to one stage and may not ${action} outside it`;
}

export function rolePrincipal(role: RolePrincipal): ApiPrincipal {
  return {
    kind: "role",
    accountId: role.accountId,
    roleId: role.roleId,
    policy: role.policy,
    ...(role.projectId ? { projectId: role.projectId } : {}),
    ...(role.stageId ? { stageId: role.stageId } : {}),
  };
}

function withinPin(principal: ApiPrincipal, resource: ApiResource): boolean {
  if (
    principal.projectId !== undefined &&
    principal.projectId !== resource.projectId
  ) {
    return false;
  }

  return (
    principal.stageId === undefined || principal.stageId === resource.stageId
  );
}

// Only resourceIds applies to an API resource; the other selectors scope agent actions.
function ruleMatches(
  rule: PolicyRule,
  action: ApiPolicyAction,
  resource: ApiResource,
): boolean {
  if (!rule.actions.includes(action)) return false;
  const resourceIds = rule.resources?.resourceIds;
  if (resourceIds === undefined || resourceIds.includes("*")) return true;

  return resource.id !== undefined && resourceIds.includes(resource.id);
}
