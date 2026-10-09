/**
 * The API authorization decision contract. Every enforcement point (the
 * config-plane HTTP funnel and core's directly-served routes) calls
 * `authorize(principal, action, resource)` and never reads the roles table
 * itself. The input shape matches an OPA query.
 */

import type {
  ApiPolicyAction,
  PolicyDocument,
  PolicyRule,
} from "./policyRules";

/** Resource-family segment of an `ApiPolicyAction`, e.g. "agents". */
export type ApiResourceType = ApiPolicyAction extends `${infer T}:${string}`
  ? T
  : never;

export interface ApiAuthorizationDecision {
  allow: boolean;
  matchedRuleIds: string[];
  reason: string;
}

/** The acting identity, as an OPA-style input document. */
export interface ApiPrincipal extends RolePrincipal {
  kind: "role";
}

export interface ApiResource {
  type: ApiResourceType;
  id?: string;
  /**
   * The stage the addressed resource lives in. Absent for a collection, an
   * account-scoped resource, or one whose stage the caller did not resolve,
   * all of which a stage-pinned role is refused.
   */
  projectId?: string;
  stageId?: string;
}

/** The role identity a bsts_ session acts as, as stored and resolved. */
export interface RolePrincipal {
  accountId: string;
  roleId: string;
  policy: PolicyDocument;
  projectId?: string;
  stageId?: string;
}

/** Map an HTTP method onto the read/write half of a resource's action pair. */
export function apiActionForRequest(
  method: string,
  resourceType: ApiResourceType,
): ApiPolicyAction {
  const upper = method.toUpperCase();
  const verb = upper === "GET" || upper === "HEAD" ? "read" : "write";

  return `${resourceType}:${verb}`;
}

/**
 * Decide whether a principal may perform an action on a resource, over the
 * role's PolicyRule list: a matching deny wins, otherwise a matching allow
 * grants, otherwise default deny. A role pinned to a project or stage is
 * refused anything outside it before any rule is read.
 */
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

/**
 * The role gate every enforcement point shares: the 403 message when the
 * request's action is denied, or null when it may proceed.
 */
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

/**
 * Whether the resource sits inside the role's project/stage pin. An unpinned
 * role passes; a pinned one needs the resource's own scope to match, so a
 * collection or account-scoped resource falls outside it.
 */
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

/**
 * Whether one rule applies to an action/resource pair. Only the `resourceIds`
 * selector constrains API resources; a rule without one covers every id.
 */
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
