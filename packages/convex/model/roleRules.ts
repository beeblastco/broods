/**
 * Account-role validation for the Convex config plane: role CRUD input,
 * assume-role input, and the fp_role_/fp_sts_ identifier generation. Role
 * policies reuse the PolicyDocument shape (model/policyRules.ts) restricted to
 * the API action namespace.
 */

import { isPlainObject } from "./objects";
import {
  API_POLICY_ACTIONS,
  normalizePolicyDocument,
  type PolicyDocument,
} from "./policyRules";

const API_POLICY_ACTION_SET = new Set<string>(API_POLICY_ACTIONS);
const ROLE_ID_PREFIX = "fp_role_";
const ROLE_ID_BYTES = 16;
const ROLE_SESSION_TOKEN_BYTES = 32;

export const ROLE_SESSION_DEFAULT_TTL_SECONDS = 60 * 60;
export const ROLE_SESSION_MAX_TTL_SECONDS = 12 * 60 * 60;
export const ROLE_SESSION_TOKEN_PREFIX = "fp_sts_";

export interface AssumeRoleInput {
  roleId: string;
  ttlSeconds: number;
}

export interface CreateRoleInput {
  name: string;
  policy: PolicyDocument;
  projectId?: string;
  stageId?: string;
}

export interface UpdateRoleInput {
  name?: string;
  policy?: PolicyDocument;
  status?: "active" | "disabled";
}

/**
 * Generate a public role id.
 * @returns "fp_role_" + random base64url
 */
export function createRoleId(): string {
  return `${ROLE_ID_PREFIX}${randomBase64Url(ROLE_ID_BYTES)}`;
}

/**
 * Generate a one-time role session token. Only its SHA-256 hash is stored.
 * @returns "fp_sts_" + random base64url
 */
export function createRoleSessionToken(): string {
  return `${ROLE_SESSION_TOKEN_PREFIX}${randomBase64Url(ROLE_SESSION_TOKEN_BYTES)}`;
}

/**
 * Validate a `POST /v1/account/assume-role` request body.
 * @param value the raw request body
 * @returns roleId plus the clamped-in-range session TTL
 */
export function normalizeAssumeRoleInput(value: unknown): AssumeRoleInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const roleId = requireString(value.roleId, "roleId");
  if (value.ttlSeconds === undefined) {
    return { roleId: roleId, ttlSeconds: ROLE_SESSION_DEFAULT_TTL_SECONDS };
  }
  if (
    typeof value.ttlSeconds !== "number" ||
    !Number.isSafeInteger(value.ttlSeconds) ||
    value.ttlSeconds < 1 ||
    value.ttlSeconds > ROLE_SESSION_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `ttlSeconds must be an integer between 1 and ${ROLE_SESSION_MAX_TTL_SECONDS}`,
    );
  }

  return { roleId: roleId, ttlSeconds: value.ttlSeconds };
}

/**
 * Validate a create-role request body.
 * @param value the raw request body
 * @returns normalized create fields
 */
export function normalizeCreateRoleInput(value: unknown): CreateRoleInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const policy = normalizeRolePolicyDocument(value.policy);
  const projectId = optionalString(value.projectId, "projectId");
  const stageId = optionalString(value.stageId, "stageId");
  // Structural scope is the deployKeys shape: a stage inside a project, or
  // account-wide. Half a scope would silently widen what fp_agent_ can assume.
  if ((projectId === undefined) !== (stageId === undefined)) {
    throw new Error("projectId and stageId must be provided together");
  }

  return {
    name: name,
    policy: policy,
    ...(projectId !== undefined ? { projectId: projectId } : {}),
    ...(stageId !== undefined ? { stageId: stageId } : {}),
  };
}

/**
 * Validate a role policy document: the shared PolicyDocument shape, with every
 * rule action drawn from the API namespace.
 * @param value candidate policy document
 * @returns normalized policy document
 */
export function normalizeRolePolicyDocument(value: unknown): PolicyDocument {
  const document = normalizePolicyDocument(value);
  for (const [index, rule] of document.rules.entries()) {
    for (const action of rule.actions) {
      if (!API_POLICY_ACTION_SET.has(action)) {
        throw new Error(
          `policy rules[${index}].actions[] must use the API namespace (e.g. "agents:read"); got "${action}"`,
        );
      }
    }
  }

  return document;
}

/**
 * Validate an update-role request body.
 * @param value the raw request body
 * @returns normalized patch fields
 */
export function normalizeUpdateRoleInput(value: unknown): UpdateRoleInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const patch: UpdateRoleInput = {};
  if (value.name !== undefined) patch.name = requireString(value.name, "name");
  if (value.policy !== undefined) {
    patch.policy = normalizeRolePolicyDocument(value.policy);
  }
  if (value.status !== undefined) {
    if (value.status !== "active" && value.status !== "disabled") {
      throw new Error("status must be one of: active, disabled");
    }
    patch.status = value.status;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Request body must include name, policy, or status");
  }

  return patch;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
