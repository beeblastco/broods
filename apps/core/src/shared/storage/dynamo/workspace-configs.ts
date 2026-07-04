/**
 * DDB-backed workspace config CRUD. Input normalization lives in
 * `../workspace-config.ts`. Workspace config holds no secrets, so the config
 * blob is stored as a plain DDB map (no encryption).
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
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  type WorkspaceConfig,
} from "../workspace-config.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./client.ts";
import { requireEnv } from "../../env.ts";
import type {
  CreateWorkspaceConfigInput,
  UpdateWorkspaceConfigInput,
  WorkspaceConfigRecord,
  WorkspaceConfigStore,
} from "../types.ts";

function workspaceConfigsTableName(): string {
  return requireEnv("WORKSPACE_CONFIGS_TABLE_NAME");
}

function createWorkspaceId(): string {
  return `ws_${randomBytes(12).toString("hex")}`;
}

function recordToItem(record: WorkspaceConfigRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    workspaceId: { S: record.workspaceId },
    name: { S: record.name },
    ...(record.description ? { description: { S: record.description } } : {}),
    config: toAttributeValue(record.config),
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
  };
}

function itemToRecord(item: Record<string, AttributeValue>): WorkspaceConfigRecord | null {
  const accountId = item.accountId?.S;
  const workspaceId = item.workspaceId?.S;
  const name = item.name?.S;
  const description = item.description?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (!accountId || !workspaceId || !name || !createdAt || !updatedAt || !item.config) {
    return null;
  }
  return {
    accountId,
    workspaceId,
    name,
    ...(description ? { description } : {}),
    config: fromAttributeValue(item.config) as WorkspaceConfig,
    createdAt,
    updatedAt,
  };
}

export const dynamoWorkspaceConfigStore: WorkspaceConfigStore = {
  async getById(accountId, workspaceId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: workspaceConfigsTableName(),
        Key: { accountId: { S: accountId }, workspaceId: { S: workspaceId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToRecord(result.Item) : null;
  },

  async list(accountId) {
    const records: WorkspaceConfigRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: workspaceConfigsTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToRecord)
          .filter((r): r is WorkspaceConfigRecord => r !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  },

  async create(accountId, input: CreateWorkspaceConfigInput) {
    const normalized = normalizeCreateWorkspaceConfigInput(input);
    const now = new Date().toISOString();
    const record: WorkspaceConfigRecord = {
      accountId,
      workspaceId: createWorkspaceId(),
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      config: normalized.config,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: workspaceConfigsTableName(),
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(workspaceId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoWorkspaceConfigStore.create(accountId, input);
      throw err;
    }
    return record;
  },

  async update(accountId, workspaceId, rawPatch: UpdateWorkspaceConfigInput) {
    const existing = await dynamoWorkspaceConfigStore.getById(accountId, workspaceId);
    if (!existing) return null;
    const patch = normalizeUpdateWorkspaceConfigInput(existing.config, rawPatch);
    const setExpressions: string[] = ["updatedAt = :updatedAt"];
    const removeExpressions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: new Date().toISOString() },
    };

    if (patch.config !== undefined) {
      setExpressions.push("#config = :config");
      names["#config"] = "config";
      values[":config"] = toAttributeValue(patch.config);
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

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: workspaceConfigsTableName(),
          Key: { accountId: { S: accountId }, workspaceId: { S: workspaceId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(workspaceId)",
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
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

  async remove(accountId, workspaceId) {
    const result = await dynamo
      .send(
        new DeleteItemCommand({
          TableName: workspaceConfigsTableName(),
          Key: { accountId: { S: accountId }, workspaceId: { S: workspaceId } },
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(workspaceId)",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },

  async removeAllForAccount(accountId) {
    const records = await dynamoWorkspaceConfigStore.list(accountId);
    await Promise.all(records.map((r) => dynamoWorkspaceConfigStore.remove(accountId, r.workspaceId)));
    return records.length;
  },
};
