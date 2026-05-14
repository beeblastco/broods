/**
 * Account-owned agent records and encrypted agent configuration storage.
 * Keep multi-agent persistence here; HTTP routing stays in account-manage.
 */

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import {
  decodeStoredAccountConfig,
  encryptAccountConfig,
  mergeAccountConfig,
  normalizeAccountConfig,
  normalizeAccountConfigPatch,
  redactAccountConfig,
  type AccountConfig,
} from "./accounts.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./dynamo.ts";
import { optionalEnv, requireEnv } from "./env.ts";
import {
  assertAccountOwnsSkillPath,
  SkillAuthorizationError,
  SkillNotFoundError,
} from "./skills.ts";

export type AgentStatus = "active" | "disabled";

export interface AgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  config: AccountConfig;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  config: AccountConfig;
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

export function createAgentId(): string {
  return `agent_${randomBytes(12).toString("hex")}`;
}

export async function createAgent(accountId: string, input: CreateAgentInput): Promise<AgentRecord> {
  const normalized = await normalizeCreateAgentInput(accountId, input);
  const now = new Date().toISOString();
  const agent: AgentRecord = {
    accountId,
    agentId: createAgentId(),
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    status: "active",
    config: normalized.config,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await dynamo.send(new PutItemCommand({
      TableName: agentConfigsTableName(),
      Item: agentToItem(agent),
      ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(agentId)",
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return createAgent(accountId, input);
    }
    throw err;
  }

  return agent;
}

export async function getAgent(accountId: string, agentId: string): Promise<AgentRecord | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: agentConfigsTableName(),
    Key: {
      accountId: { S: accountId },
      agentId: { S: agentId },
    },
    ConsistentRead: true,
  }));

  return result.Item ? itemToAgent(result.Item) : null;
}

export async function listAgents(accountId: string): Promise<AgentRecord[]> {
  const agents: AgentRecord[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: agentConfigsTableName(),
      KeyConditionExpression: "accountId = :accountId",
      ExpressionAttributeValues: {
        ":accountId": { S: accountId },
      },
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }));

    agents.push(
      ...(result.Items ?? [])
        .map(itemToAgent)
        .filter((agent): agent is AgentRecord => agent !== null),
    );
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return agents;
}

export async function updateAgent(
  accountId: string,
  agentId: string,
  input: UpdateAgentInput,
): Promise<AgentRecord | null> {
  const existing = await getAgent(accountId, agentId);
  if (!existing) {
    return null;
  }

  const normalized = await normalizeUpdateAgentInput(accountId, existing.config, input);
  const setExpressions = [
    "#config = :config",
    "updatedAt = :updatedAt",
    ...(normalized.name !== undefined ? ["#name = :name"] : []),
    ...(normalized.description !== undefined && normalized.description !== null ? ["description = :description"] : []),
    ...(normalized.status !== undefined ? ["#status = :status"] : []),
  ];
  const removeExpressions = normalized.description === null ? ["description"] : [];
  const result = await dynamo.send(new UpdateItemCommand({
    TableName: agentConfigsTableName(),
    Key: {
      accountId: { S: accountId },
      agentId: { S: agentId },
    },
    UpdateExpression: [
      `SET ${setExpressions.join(", ")}`,
      ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
    ].join(" "),
    ConditionExpression: "attribute_exists(accountId) AND attribute_exists(agentId)",
    ExpressionAttributeNames: {
      "#config": "config",
      ...(normalized.name !== undefined ? { "#name": "name" } : {}),
      ...(normalized.status !== undefined ? { "#status": "status" } : {}),
    },
    ExpressionAttributeValues: {
      ":config": toAttributeValue(encryptAccountConfig(normalized.config)),
      ":updatedAt": { S: new Date().toISOString() },
      ...(normalized.name !== undefined ? { ":name": { S: normalized.name } } : {}),
      ...(normalized.description !== undefined && normalized.description !== null
        ? { ":description": { S: normalized.description } }
        : {}),
      ...(normalized.status !== undefined ? { ":status": { S: normalized.status } } : {}),
    },
    ReturnValues: "ALL_NEW",
  })).catch((err) => {
    if (isConditionalCheckFailed(err)) {
      return null;
    }
    throw err;
  });

  return result?.Attributes ? itemToAgent(result.Attributes) : null;
}

export async function deleteAgent(accountId: string, agentId: string): Promise<boolean> {
  const result = await dynamo.send(new DeleteItemCommand({
    TableName: agentConfigsTableName(),
    Key: {
      accountId: { S: accountId },
      agentId: { S: agentId },
    },
    ConditionExpression: "attribute_exists(accountId) AND attribute_exists(agentId)",
  })).catch((err) => {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  });

  return result !== false;
}

export async function deleteAccountAgents(accountId: string): Promise<number> {
  const agents = await listAgents(accountId);
  await Promise.all(agents.map((agent) => deleteAgent(accountId, agent.agentId)));
  return agents.length;
}

export function toPublicAgent(agent: AgentRecord): PublicAgentRecord {
  return {
    accountId: agent.accountId,
    agentId: agent.agentId,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    status: agent.status,
    config: redactAccountConfig(agent.config),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export async function validateAgentSkillPaths(accountId: string, config: AccountConfig): Promise<void> {
  for (const skillPath of config.skills?.allowed ?? []) {
    try {
      await assertAccountOwnsSkillPath(accountId, skillPath);
    } catch (err) {
      if (err instanceof SkillAuthorizationError) {
        throw new AgentSkillAuthorizationError(err.skillPath);
      }
      if (err instanceof SkillNotFoundError) {
        throw new AgentSkillNotFoundError(err.skillPath);
      }
      throw err;
    }
  }
}

export async function validateAgentSubagentIds(accountId: string, config: AccountConfig): Promise<void> {
  for (const agentId of config.subagent?.allowed ?? []) {
    const agent = await getAgent(accountId, agentId);
    if (!agent || agent.status !== "active") {
      throw new AgentSubagentNotFoundError(agentId);
    }
  }
}

async function normalizeCreateAgentInput(accountId: string, value: CreateAgentInput): Promise<{
  name: string;
  description?: string;
  config: AccountConfig;
}> {
  if (!isPlainObject(value)) {
    throw new Error("Request body must be an object");
  }

  const name = normalizeRequiredString(value.name, "name");
  const description = normalizeOptionalString(value.description, "description");
  const config = normalizeAccountConfig(value.config);
  await validateAgentSkillPaths(accountId, config);
  await validateAgentSubagentIds(accountId, config);
  return {
    name,
    ...(description ? { description } : {}),
    config,
  };
}

async function normalizeUpdateAgentInput(
  accountId: string,
  existingConfig: AccountConfig,
  value: UpdateAgentInput,
): Promise<UpdateAgentInput & { config: AccountConfig }> {
  if (!isPlainObject(value)) {
    throw new Error("Request body must be an object");
  }

  const config = "config" in value
    ? mergeAccountConfig(existingConfig, normalizeAccountConfigPatch(value.config))
    : existingConfig;
  await validateAgentSkillPaths(accountId, config);
  await validateAgentSubagentIds(accountId, config);

  return {
    ...(value.name !== undefined ? { name: normalizeRequiredString(value.name, "name") } : {}),
    ...(value.description !== undefined
      ? { description: value.description === null ? null : normalizeOptionalString(value.description, "description") }
      : {}),
    ...(value.status !== undefined ? { status: normalizeAgentStatus(value.status) } : {}),
    config,
  };
}

function agentToItem(agent: AgentRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: agent.accountId },
    agentId: { S: agent.agentId },
    name: { S: agent.name },
    ...(agent.description ? { description: { S: agent.description } } : {}),
    status: { S: agent.status },
    config: toAttributeValue(encryptAccountConfig(agent.config)),
    createdAt: { S: agent.createdAt },
    updatedAt: { S: agent.updatedAt },
  };
}

function itemToAgent(item: Record<string, AttributeValue>): AgentRecord | null {
  const accountId = item.accountId?.S;
  const agentId = item.agentId?.S;
  const name = item.name?.S;
  const description = item.description?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;

  if (!accountId || !agentId || !name || !isAgentStatus(status) || !createdAt || !updatedAt) {
    return null;
  }

  return {
    accountId,
    agentId,
    name,
    ...(description ? { description } : {}),
    status,
    config: decodeStoredAccountConfig(item.config ? fromAttributeValue(item.config) : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeAgentStatus(value: unknown): AgentStatus {
  if (!isAgentStatus(value)) {
    throw new Error("status must be one of: active, disabled");
  }
  return value;
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return value === "active" || value === "disabled";
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function agentConfigsTableName(): string {
  return optionalEnv("AGENT_CONFIGS_TABLE_NAME") ?? requireEnv("ACCOUNT_CONFIGS_TABLE_NAME");
}
