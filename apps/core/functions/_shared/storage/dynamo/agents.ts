/**
 * DDB-backed agent CRUD. Input normalization, skill-path / subagent-id
 * validation, and the public projection live in `../agents.ts` and are
 * called at the create/update entry points so both DynamoDB and Convex
 * stores enforce the same input contract.
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
  decodeStoredAgentConfig,
  encryptAgentConfig,
  type AgentConfig,
} from "../agent-config.ts";
import {
  normalizeCreateAgentInput,
  normalizeUpdateAgentInput,
} from "../agents.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./client.ts";
import { optionalEnv, requireEnv } from "../../env.ts";
import type {
  AgentRecord,
  AgentStatus,
  AgentStore,
  CreateAgentInput,
  UpdateAgentInput,
} from "../types.ts";

function agentConfigsTableName(): string {
  return optionalEnv("AGENT_CONFIGS_TABLE_NAME") ?? requireEnv("ACCOUNT_CONFIGS_TABLE_NAME");
}

function createAgentId(): string {
  return `agent_${randomBytes(12).toString("hex")}`;
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return value === "active" || value === "disabled";
}

function agentToItem(agent: AgentRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: agent.accountId },
    agentId: { S: agent.agentId },
    name: { S: agent.name },
    ...(agent.description ? { description: { S: agent.description } } : {}),
    status: { S: agent.status },
    config: toAttributeValue(encryptAgentConfig(agent.config)),
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
    config: decodeStoredAgentConfig(item.config ? fromAttributeValue(item.config) : {}),
    createdAt,
    updatedAt,
  };
}

export const dynamoAgentStore: AgentStore = {
  async getById(accountId, agentId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: agentConfigsTableName(),
        Key: { accountId: { S: accountId }, agentId: { S: agentId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToAgent(result.Item) : null;
  },

  async list(accountId) {
    const agents: AgentRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: agentConfigsTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      agents.push(
        ...(result.Items ?? [])
          .map(itemToAgent)
          .filter((a): a is AgentRecord => a !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return agents;
  },

  async create(accountId, input: CreateAgentInput) {
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
      await dynamo.send(
        new PutItemCommand({
          TableName: agentConfigsTableName(),
          Item: agentToItem(agent),
          ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(agentId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoAgentStore.create(accountId, input);
      throw err;
    }
    return agent;
  },

  async update(accountId, agentId, rawPatch: UpdateAgentInput) {
    const existing = await dynamoAgentStore.getById(accountId, agentId);
    if (!existing) return null;
    const patch = await normalizeUpdateAgentInput(accountId, existing.config, rawPatch);
    const setExpressions: string[] = ["updatedAt = :updatedAt"];
    const removeExpressions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: new Date().toISOString() },
    };

    if (patch.config !== undefined) {
      setExpressions.push("#config = :config");
      names["#config"] = "config";
      values[":config"] = toAttributeValue(encryptAgentConfig(patch.config as AgentConfig));
    }
    if (patch.name !== undefined) {
      setExpressions.push("#name = :name");
      names["#name"] = "name";
      values[":name"] = { S: patch.name };
    }
    if (patch.description !== undefined) {
      if (patch.description === null) removeExpressions.push("description");
      else {
        setExpressions.push("description = :description");
        values[":description"] = { S: patch.description };
      }
    }
    if (patch.status !== undefined) {
      setExpressions.push("#status = :status");
      names["#status"] = "status";
      values[":status"] = { S: patch.status };
    }

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: agentConfigsTableName(),
          Key: { accountId: { S: accountId }, agentId: { S: agentId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(agentId)",
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      });

    return result?.Attributes ? itemToAgent(result.Attributes) : null;
  },

  async remove(accountId, agentId) {
    const result = await dynamo
      .send(
        new DeleteItemCommand({
          TableName: agentConfigsTableName(),
          Key: { accountId: { S: accountId }, agentId: { S: agentId } },
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(agentId)",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },

  async removeAllForAccount(accountId) {
    const agents = await dynamoAgentStore.list(accountId);
    await Promise.all(agents.map((a) => dynamoAgentStore.remove(accountId, a.agentId)));
    return agents.length;
  },
};
