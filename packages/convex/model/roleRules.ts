/**
 * Account-role validation for the Convex config plane: role CRUD input,
 * assume-role input, and the fp_role_/fp_sts_ identifier generation. Role
 * policies reuse the PolicyDocument shape (model/policyRules.ts) restricted to
 * the API action namespace.
 */

import { randomToken } from "./accountSecrets";
import { isPlainObject } from "./objects";
import {
  API_POLICY_ACTIONS,
  normalizePolicyDocument,
  type PolicyDocument,
} from "./policyRules";

const ROLE_ID_BYTES = 16;
const ROLE_ID_PREFIX = "fp_role_";

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

/** Generate a public role id: "fp_role_" + random base64url. */
export function createRoleId(): string {
  return randomToken(ROLE_ID_PREFIX, ROLE_ID_BYTES);
}

/** Generate a one-time role session token. Only its SHA-256 hash is stored. */
export function createRoleSessionToken(): string {
  return randomToken(ROLE_SESSION_TOKEN_PREFIX);
}

/** Validate a `POST /v1/account/assume-role` request body. */
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

/** Validate a create-role request body. */
export function normalizeCreateRoleInput(value: unknown): CreateRoleInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const policy = normalizePolicyDocument(value.policy, API_POLICY_ACTIONS);
  const projectId = optionalString(value.projectId, "projectId");
  const stageId = optionalString(value.stageId, "stageId");

  return {
    name: name,
    policy: policy,
    ...(projectId !== undefined ? { projectId: projectId } : {}),
    ...(stageId !== undefined ? { stageId: stageId } : {}),
  };
}

/** Validate an update-role request body. */
export function normalizeUpdateRoleInput(value: unknown): UpdateRoleInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const patch: UpdateRoleInput = {};
  if (value.name !== undefined) patch.name = requireString(value.name, "name");
  if (value.policy !== undefined) {
    patch.policy = normalizePolicyDocument(value.policy, API_POLICY_ACTIONS);
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
