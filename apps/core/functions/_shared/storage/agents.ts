/**
 * Agent types, input normalization, skill/subagent validation, and the
 * public/redacted projection. Provider-agnostic — both DynamoDB and
 * Convex stores import the normalizer at their create/update entry
 * points so behaviour is symmetric across modes.
 */

import {
  mergeAgentConfig,
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
  redactAgentConfig,
  type AgentConfig,
} from "./agent-config.ts";
import {
  assertAccountOwnsSkillPath,
  SkillAuthorizationError,
  SkillNotFoundError,
} from "../skills.ts";
import { isPlainObject } from "../object.ts";
import { getStorage } from "./index.ts";

export type AgentStatus = "active" | "disabled";

export interface AgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  config: AgentConfig;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  config: AgentConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  config: unknown;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string | null;
  status?: AgentStatus;
  config?: unknown;
}

export class AgentSkillAuthorizationError extends Error {
  constructor(public readonly skillPath: string) {
    super(`Skill path belongs to another account: ${skillPath}`);
  }
}

export class AgentSkillNotFoundError extends Error {
  constructor(public readonly skillPath: string) {
    super(`Skill not found: ${skillPath}`);
  }
}

export class AgentSubagentNotFoundError extends Error {
  constructor(public readonly agentId: string) {
    super(`Subagent not found: ${agentId}`);
  }
}

export async function validateAgentSkillPaths(accountId: string, config: AgentConfig): Promise<void> {
  for (const skillPath of config.skills?.allowed ?? []) {
    try {
      await assertAccountOwnsSkillPath(accountId, skillPath);
    } catch (err) {
      if (err instanceof SkillAuthorizationError) throw new AgentSkillAuthorizationError(err.skillPath);
      if (err instanceof SkillNotFoundError) throw new AgentSkillNotFoundError(err.skillPath);
      throw err;
    }
  }
}

export async function validateAgentSubagentIds(accountId: string, config: AgentConfig): Promise<void> {
  for (const agentId of config.subagent?.allowed ?? []) {
    const agent = await getStorage().agents.getById(accountId, agentId);
    if (!agent || agent.status !== "active") {
      throw new AgentSubagentNotFoundError(agentId);
    }
  }
}

export async function normalizeCreateAgentInput(
  accountId: string,
  value: CreateAgentInput,
): Promise<{ name: string; description?: string; config: AgentConfig }> {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const description = optionalString(value.description, "description");
  const config = normalizeAgentConfig(value.config);
  await validateAgentSkillPaths(accountId, config);
  await validateAgentSubagentIds(accountId, config);
  return {
    name,
    ...(description ? { description } : {}),
    config,
  };
}

export async function normalizeUpdateAgentInput(
  accountId: string,
  existingConfig: AgentConfig,
  value: UpdateAgentInput,
): Promise<UpdateAgentInput & { config: AgentConfig }> {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");

  const config = "config" in value
    ? mergeAgentConfig(existingConfig, normalizeAgentConfigPatch(value.config))
    : existingConfig;
  await validateAgentSkillPaths(accountId, config);
  await validateAgentSubagentIds(accountId, config);

  return {
    ...(value.name !== undefined ? { name: requireString(value.name, "name") } : {}),
    ...(value.description !== undefined
      ? { description: value.description === null ? null : optionalString(value.description, "description") }
      : {}),
    ...(value.status !== undefined ? { status: requireAgentStatus(value.status) } : {}),
    config,
  };
}

export function toPublicAgent(agent: AgentRecord): PublicAgentRecord {
  return {
    accountId: agent.accountId,
    agentId: agent.agentId,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    status: agent.status,
    config: redactAgentConfig(agent.config),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return value === "active" || value === "disabled";
}

function requireAgentStatus(value: unknown): AgentStatus {
  if (!isAgentStatus(value)) throw new Error("status must be one of: active, disabled");
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
