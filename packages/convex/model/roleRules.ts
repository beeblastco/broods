import { z } from "zod/mini";

import { randomToken } from "./accountSecrets";
import { nonEmptyString, parseInput } from "./inputSchema";
import {
  API_POLICY_ACTIONS,
  normalizePolicyDocument,
  type PolicyDocument,
} from "./policyRules";
import { ClientError } from "./clientError";

const ROLE_ID_BYTES = 16;
export const ROLE_ID_PREFIX = "brole_";

export const ROLE_SESSION_DEFAULT_TTL_SECONDS = 60 * 60;
export const ROLE_SESSION_MAX_TTL_SECONDS = 12 * 60 * 60;
export const ROLE_SESSION_TOKEN_PREFIX = "bsts_";

const ASSUME_ROLE_INPUT = z.looseObject(
  {
    roleId: nonEmptyString,
    ttlSeconds: z.optional(
      z
        .number({
          error: `must be an integer between 1 and ${ROLE_SESSION_MAX_TTL_SECONDS}`,
        })
        .check(
          z.refine(
            (value): boolean =>
              Number.isSafeInteger(value) &&
              value >= 1 &&
              value <= ROLE_SESSION_MAX_TTL_SECONDS,
            {
              error: `must be an integer between 1 and ${ROLE_SESSION_MAX_TTL_SECONDS}`,
            },
          ),
        ),
    ),
  },
  { error: "Request body must be an object" },
);
const CREATE_ROLE_INPUT = z.looseObject(
  {
    name: nonEmptyString,
    policy: z.optional(z.unknown()),
    projectId: z.optional(z.string()),
    stageId: z.optional(z.string()),
  },
  { error: "Request body must be an object" },
);
const UPDATE_ROLE_INPUT = z.looseObject(
  {
    name: z.optional(nonEmptyString),
    policy: z.optional(z.unknown()),
    status: z.optional(z.enum(["active", "disabled"])),
  },
  { error: "Request body must be an object" },
);

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

export function createRoleId(): string {
  return randomToken(ROLE_ID_PREFIX, ROLE_ID_BYTES);
}

// Shown once: only its SHA-256 hash is stored.
export function createRoleSessionToken(): string {
  return randomToken(ROLE_SESSION_TOKEN_PREFIX);
}

export function normalizeAssumeRoleInput(value: unknown): AssumeRoleInput {
  const input = parseInput(ASSUME_ROLE_INPUT, value, "");

  return {
    roleId: input.roleId.trim(),
    ttlSeconds: input.ttlSeconds ?? ROLE_SESSION_DEFAULT_TTL_SECONDS,
  };
}

export function normalizeCreateRoleInput(value: unknown): CreateRoleInput {
  const input = parseInput(CREATE_ROLE_INPUT, value, "");
  const policy = normalizePolicyDocument(input.policy, API_POLICY_ACTIONS);
  const projectId = input.projectId?.trim() || undefined;
  const stageId = input.stageId?.trim() || undefined;

  return {
    name: input.name.trim(),
    policy: policy,
    ...(projectId !== undefined ? { projectId: projectId } : {}),
    ...(stageId !== undefined ? { stageId: stageId } : {}),
  };
}

export function normalizeUpdateRoleInput(value: unknown): UpdateRoleInput {
  const input = parseInput(UPDATE_ROLE_INPUT, value, "");
  const patch: UpdateRoleInput = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.policy !== undefined
      ? { policy: normalizePolicyDocument(input.policy, API_POLICY_ACTIONS) }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new ClientError("Request body must include name, policy, or status");
  }

  return patch;
}
