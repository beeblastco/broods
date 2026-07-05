/**
 * Agent-policy validation and public response mapping for the Convex config
 * plane. Ports core's public CRUD normalizer so policy documents keep the
 * account-management API contract.
 */

import type { Doc } from "../_generated/dataModel";
import { isPlainObject } from "./objects";

export const AGENT_POLICY_ACTIONS = [
    "tool.call",
    "workspace.read",
    "workspace.write",
    "workspace.exec",
    "subagent.run",
    "skill.load",
] as const;

export type AgentPolicyAction = (typeof AGENT_POLICY_ACTIONS)[number];
export type AgentPolicyEffect = "allow" | "deny";
export type AgentPolicyConditionOperator = "equals" | "notEquals" | "in" | "notIn" | "prefix" | "contains";

/**
 * One optional predicate on a policy rule.
 */
export interface AgentPolicyCondition {
    attribute: string;
    operator: AgentPolicyConditionOperator;
    value: string | number | boolean | string[] | number[] | boolean[];
}

/**
 * Resource selector fields supported by policy rules.
 */
export interface AgentPolicyResourceSelector {
    toolNames?: string[];
    toolIds?: string[];
    workspaceIds?: string[];
    workspaceNames?: string[];
    filePaths?: string[];
    subagentIds?: string[];
    skillPaths?: string[];
}

/**
 * One allow/deny rule inside a policy document.
 */
export interface AgentPolicyRule {
    id: string;
    effect: AgentPolicyEffect;
    actions: AgentPolicyAction[];
    resources?: AgentPolicyResourceSelector;
    conditions?: AgentPolicyCondition[];
}

/**
 * Versioned policy document accepted by account-management CRUD.
 */
export interface AgentPolicyDocument {
    version: 1;
    rules: AgentPolicyRule[];
}

/**
 * Validate a create-policy request body.
 * @param value the raw request body
 * @returns normalized create fields
 */
export function normalizeCreateAgentPolicyInput(
    value: unknown,
): { name: string; description?: string; document: AgentPolicyDocument } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");
    const name = requireString(value.name, "name");
    const description = optionalString(value.description, "description");
    const document = normalizeAgentPolicyDocument(value.document);

    return {
        name: name,
        ...(description ? { description: description } : {}),
        document: document,
    };
}

/**
 * Validate an update-policy request body.
 * @param value the raw request body
 * @returns normalized patch fields
 */
export function normalizeUpdateAgentPolicyInput(
    value: unknown,
): { name?: string; description?: string | null; document?: AgentPolicyDocument; status?: "active" | "deleted" } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");
    const patch: { name?: string; description?: string | null; document?: AgentPolicyDocument; status?: "active" | "deleted" } = {};
    if (value.name !== undefined) patch.name = requireString(value.name, "name");
    if (value.description !== undefined) patch.description = value.description === null ? null : optionalString(value.description, "description");
    if (value.document !== undefined) patch.document = normalizeAgentPolicyDocument(value.document);
    if (value.status !== undefined) {
        if (value.status !== "active" && value.status !== "deleted") {
            throw new Error("status must be one of: active, deleted");
        }
        patch.status = value.status;
    }

    return patch;
}

/**
 * Validate and normalize a versioned policy document.
 * @param value candidate policy document
 * @returns normalized policy document
 */
export function normalizeAgentPolicyDocument(value: unknown): AgentPolicyDocument {
    if (!isPlainObject(value)) throw new Error("policy document must be an object");
    const document = value;
    if (document.version !== 1) throw new Error("policy document version must be 1");
    if (!Array.isArray(document.rules)) throw new Error("policy document rules must be an array");

    return {
        version: 1,
        rules: document.rules.map((rule, index) => normalizeAgentPolicyRule(rule, index)),
    };
}

/**
 * Map an agentPolicies document to the public account-management shape.
 * @param doc the agentPolicies document
 * @returns the public policy record
 */
export function toPublicAgentPolicyResponse(doc: Doc<"agentPolicies">): Record<string, unknown> {
    return {
        accountId: doc.accountId,
        policyId: doc._id,
        name: doc.name,
        ...(doc.description ? { description: doc.description } : {}),
        document: doc.document,
        status: doc.status,
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
    };
}

function normalizeAgentPolicyRule(value: unknown, index: number): AgentPolicyRule {
    if (!isPlainObject(value)) throw new Error(`policy rules[${index}] must be an object`);
    const rule = value;
    const id = optionalString(rule.id, `policy rules[${index}].id`) ?? `rule-${index + 1}`;
    assertOptionalEnum(rule.effect, `policy rules[${index}].effect`, ["allow", "deny"]);
    if (rule.effect === undefined) throw new Error(`policy rules[${index}].effect is required`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
        throw new Error(`policy rules[${index}].actions must be a non-empty array`);
    }
    for (const action of rule.actions) {
        assertOptionalEnum(action, `policy rules[${index}].actions[]`, AGENT_POLICY_ACTIONS);
    }

    return {
        id: id,
        effect: rule.effect as AgentPolicyEffect,
        actions: rule.actions as AgentPolicyAction[],
        ...(rule.resources !== undefined ? { resources: normalizeResourceSelector(rule.resources, index) } : {}),
        ...(rule.conditions !== undefined ? { conditions: normalizeConditions(rule.conditions, index) } : {}),
    };
}

const RESOURCE_SELECTOR_KEYS = ["toolNames", "toolIds", "workspaceIds", "workspaceNames", "filePaths", "subagentIds", "skillPaths"] as const;

function normalizeResourceSelector(value: unknown, index: number): AgentPolicyResourceSelector {
    if (!isPlainObject(value)) throw new Error(`policy rules[${index}].resources must be an object`);
    const selector = value;
    for (const key of Object.keys(selector)) {
        if (!RESOURCE_SELECTOR_KEYS.includes(key as (typeof RESOURCE_SELECTOR_KEYS)[number])) {
            throw new Error(`policy rules[${index}].resources.${key} is not supported`);
        }
    }
    for (const key of RESOURCE_SELECTOR_KEYS) {
        assertOptionalStringArray(selector[key], `policy rules[${index}].resources.${key}`);
    }

    return selector as AgentPolicyResourceSelector;
}

function normalizeConditions(value: unknown, index: number): AgentPolicyCondition[] {
    if (!Array.isArray(value)) throw new Error(`policy rules[${index}].conditions must be an array`);

    return value.map((condition, conditionIndex) => {
        if (!isPlainObject(condition)) {
            throw new Error(`policy rules[${index}].conditions[${conditionIndex}] must be an object`);
        }
        const record = condition;
        const attribute = requireString(record.attribute, `policy rules[${index}].conditions[${conditionIndex}].attribute`);
        assertOptionalEnum(record.operator, `policy rules[${index}].conditions[${conditionIndex}].operator`, [
            "equals",
            "notEquals",
            "in",
            "notIn",
            "prefix",
            "contains",
        ]);
        if (record.operator === undefined) {
            throw new Error(`policy rules[${index}].conditions[${conditionIndex}].operator is required`);
        }
        if (!isConditionValue(record.value)) {
            throw new Error(`policy rules[${index}].conditions[${conditionIndex}].value is invalid`);
        }

        return {
            attribute: attribute,
            operator: record.operator as AgentPolicyConditionOperator,
            value: record.value,
        };
    });
}

function isConditionValue(value: unknown): value is AgentPolicyCondition["value"] {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
    if (!Array.isArray(value)) return false;
    if (value.length === 0) return true;
    const elementType = typeof value[0];
    if (elementType !== "string" && elementType !== "number" && elementType !== "boolean") return false;

    return value.every((entry) => typeof entry === elementType);
}

function assertOptionalStringArray(value: unknown, name: string): void {
    if (value !== undefined && (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0))) {
        throw new Error(`${name} must be an array of non-empty strings`);
    }
}

function assertOptionalEnum<T extends readonly string[]>(value: unknown, name: string, values: T): void {
    if (value !== undefined && !values.includes(value as T[number])) {
        throw new Error(`${name} must be one of: ${values.join(", ")}`);
    }
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);

    return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : undefined;
}
