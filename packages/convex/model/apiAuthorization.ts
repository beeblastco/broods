/**
 * The API authorization decision contract. Every enforcement point (the
 * config-plane HTTP funnel and core's directly-served routes) calls
 * `authorize(principal, action, resource)` and never reads the roles table
 * itself. The input shape matches an OPA query, so a central OPA service can
 * replace this in-process backing later without touching any caller.
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

/** The decision, plus the rule ids that produced it for audit logs. */
export interface ApiAuthorizationDecision {
  allow: boolean;
  matchedRuleIds: string[];
  reason: string;
}

/** The acting identity, as an OPA-style input document. */
export interface ApiPrincipal {
  kind: "role";
  accountId: string;
  roleId: string;
  policy: PolicyDocument;
  projectId?: string;
  stageId?: string;
}

/** The config-plane resource a request addresses. */
export interface ApiResource {
  type: ApiResourceType;
  id?: string;
}

/**
 * Map an HTTP method onto the read/write half of a resource's action pair.
 * @param method HTTP request method
 * @param resourceType config-plane resource family
 * @returns the API action the request needs
 */
export function apiActionForRequest(
  method: string,
  resourceType: ApiResourceType,
): ApiPolicyAction {
  const upper = method.toUpperCase();
  const verb = upper === "GET" || upper === "HEAD" ? "read" : "write";

  return `${resourceType}:${verb}`;
}

/**
 * Decide whether a principal may perform an action on a resource. In-process
 * backing over the role's PolicyRule list: a matching deny wins, otherwise a
 * matching allow grants, otherwise default deny.
 * @param principal the acting identity
 * @param action the API action the request needs
 * @param resource the resource the request addresses
 * @returns allow/deny plus the rule ids that decided it
 */
export function authorize(
  principal: ApiPrincipal,
  action: ApiPolicyAction,
  resource: ApiResource,
): ApiAuthorizationDecision {
  const matched = principal.policy.rules.filter((rule) =>
    ruleMatches(rule, action, resource),
  );
  const denies = matched.filter((rule) => rule.effect === "deny");
  if (denies.length > 0) {
    return {
      allow: false,
      matchedRuleIds: denies.map((rule) => rule.id),
      reason: `denied by rule ${denies[0]!.id}`,
    };
  }
  const allows = matched.filter((rule) => rule.effect === "allow");
  if (allows.length > 0) {
    return {
      allow: true,
      matchedRuleIds: allows.map((rule) => rule.id),
      reason: `allowed by rule ${allows[0]!.id}`,
    };
  }

  return {
    allow: false,
    matchedRuleIds: [],
    reason: `no rule allows ${action}`,
  };
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
