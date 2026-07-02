/**
 * DDB-backed reusable agent policy CRUD.
 */

import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { requireEnv } from "../../env.ts";
import {
  createAgentPolicyId,
  normalizeCreateAgentPolicyInput,
  normalizeUpdateAgentPolicyInput,
  type AgentPolicyDocument,
  type AgentPolicyRecord,
} from "../agent-policy.ts";
import type {
  AgentPolicyStore,
  CreateAgentPolicyInput,
  UpdateAgentPolicyInput,
} from "../types.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./client.ts";

function agentPoliciesTableName(): string {
  return requireEnv("AGENT_POLICIES_TABLE_NAME");
}

function recordToItem(record: AgentPolicyRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    policyId: { S: record.policyId },
    name: { S: record.name },
    ...(record.description ? { description: { S: record.description } } : {}),
    document: toAttributeValue(record.document),
    status: { S: record.status },
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
  };
}

function itemToRecord(item: Record<string, AttributeValue>): AgentPolicyRecord | null {
  const accountId = item.accountId?.S;
  const policyId = item.policyId?.S;
  const name = item.name?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (!accountId || !policyId || !name || !status || !createdAt || !updatedAt || !item.document) {
    return null;
  }

  return {
    accountId,
    policyId,
    name,
    ...(item.description?.S ? { description: item.description.S } : {}),
    document: fromAttributeValue(item.document) as AgentPolicyRecord["document"],
    status: status === "deleted" ? "deleted" : "active",
    createdAt,
    updatedAt,
  };
}

export const dynamoAgentPolicyStore: AgentPolicyStore = {
  async getById(accountId, policyId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: agentPoliciesTableName(),
        Key: { accountId: { S: accountId }, policyId: { S: policyId } },
        ConsistentRead: true,
      }),
    );
    const record = result.Item ? itemToRecord(result.Item) : null;
    return record?.status === "active" ? record : null;
  },

  async list(accountId) {
    const records: AgentPolicyRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: agentPoliciesTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToRecord)
          .filter((record): record is AgentPolicyRecord => record !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return records.filter((record) => record.status === "active");
  },

  async create(accountId, input: CreateAgentPolicyInput) {
    const normalized = normalizeCreateAgentPolicyInput(input);
    const now = new Date().toISOString();
    const record: AgentPolicyRecord = {
      accountId,
      policyId: createAgentPolicyId(),
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      document: normalized.document as AgentPolicyDocument,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: agentPoliciesTableName(),
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(policyId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoAgentPolicyStore.create(accountId, input);
      throw err;
    }

    return record;
  },

  async update(accountId, policyId, rawPatch: UpdateAgentPolicyInput) {
    const existing = await dynamoAgentPolicyStore.getById(accountId, policyId);
    if (!existing) return null;
    const patch = normalizeUpdateAgentPolicyInput(rawPatch);
    const setExpressions: string[] = ["updatedAt = :updatedAt"];
    const removeExpressions: string[] = [];
    // Condition on active status so a stale update cannot resurrect or mutate
    // a concurrently soft-deleted policy.
    const names: Record<string, string> = { "#status": "status" };
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: new Date().toISOString() },
      ":activeStatus": { S: "active" },
    };

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
    if (patch.document !== undefined) {
      setExpressions.push("document = :document");
      values[":document"] = toAttributeValue(patch.document);
    }
    if (patch.status !== undefined) {
      setExpressions.push("#status = :status");
      values[":status"] = { S: patch.status };
    }

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: agentPoliciesTableName(),
          Key: { accountId: { S: accountId }, policyId: { S: policyId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(policyId) AND #status = :activeStatus",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      });

    return result?.Attributes ? itemToRecord(result.Attributes) : null;
  },

  async remove(accountId, policyId) {
    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: agentPoliciesTableName(),
          Key: { accountId: { S: accountId }, policyId: { S: policyId } },
          UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
          // Only active policies can transition to deleted, so a repeated
          // delete reports false and the handler maps it to 404.
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(policyId) AND #status = :activeStatus",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "deleted" },
            ":activeStatus": { S: "active" },
            ":updatedAt": { S: new Date().toISOString() },
          },
        }),
      )
      .then(() => true)
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });

    return result;
  },

  async removeAllForAccount(accountId) {
    const records = await dynamoAgentPolicyStore.list(accountId);
    for (const record of records) {
      await dynamoAgentPolicyStore.remove(accountId, record.policyId);
    }

    return records.length;
  },
};
