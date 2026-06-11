/**
 * DDB-backed account tool metadata CRUD.
 * Bundle objects stay in S3; this table stores account-scoped active metadata.
 */

import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  createAccountToolId,
  normalizeCreateAccountToolInput,
  normalizeUpdateAccountToolInput,
  type AccountToolRecord,
} from "../account-tools.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./client.ts";
import { requireEnv } from "../../env.ts";
import type {
  AccountToolStore,
  CreateAccountToolInput,
  UpdateAccountToolInput,
} from "../types.ts";

function accountToolsTableName(): string {
  return requireEnv("ACCOUNT_TOOLS_TABLE_NAME");
}

function recordToItem(record: AccountToolRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    toolId: { S: record.toolId },
    name: { S: record.name },
    description: { S: record.description },
    inputSchema: toAttributeValue(record.inputSchema),
    bundleStorageKey: { S: record.bundleStorageKey },
    sha256: { S: record.sha256 },
    ...(record.defaultConfig !== undefined ? { defaultConfig: toAttributeValue(record.defaultConfig) } : {}),
    status: { S: record.status },
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
    ...(record.deletedAt ? { deletedAt: { S: record.deletedAt } } : {}),
  };
}

function itemToRecord(item: Record<string, AttributeValue>): AccountToolRecord | null {
  const accountId = item.accountId?.S;
  const toolId = item.toolId?.S;
  const name = item.name?.S;
  const description = item.description?.S;
  const bundleStorageKey = item.bundleStorageKey?.S;
  const sha256 = item.sha256?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (!accountId || !toolId || !name || !description || !bundleStorageKey || !sha256 || !status || !createdAt || !updatedAt || !item.inputSchema) {
    return null;
  }
  return {
    accountId,
    toolId,
    name,
    description,
    inputSchema: fromAttributeValue(item.inputSchema) as AccountToolRecord["inputSchema"],
    bundleStorageKey,
    sha256,
    ...(item.defaultConfig ? { defaultConfig: fromAttributeValue(item.defaultConfig) as Record<string, unknown> } : {}),
    status: status === "deleted" ? "deleted" : "active",
    createdAt,
    updatedAt,
    ...(item.deletedAt?.S ? { deletedAt: item.deletedAt.S } : {}),
  };
}

export const dynamoAccountToolStore: AccountToolStore = {
  async getById(accountId, toolId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: accountToolsTableName(),
        Key: { accountId: { S: accountId }, toolId: { S: toolId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToRecord(result.Item) : null;
  },

  async list(accountId) {
    const records: AccountToolRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: accountToolsTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToRecord)
          .filter((record): record is AccountToolRecord => record !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records.filter((record) => record.status === "active");
  },

  async create(accountId, input: CreateAccountToolInput) {
    const normalized = normalizeCreateAccountToolInput(input);
    const now = new Date().toISOString();
    const record: AccountToolRecord = {
      accountId,
      toolId: createAccountToolId(),
      name: normalized.name,
      description: normalized.description,
      inputSchema: normalized.inputSchema,
      bundleStorageKey: normalized.bundleStorageKey,
      sha256: normalized.sha256,
      ...(normalized.defaultConfig !== undefined ? { defaultConfig: normalized.defaultConfig } : {}),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: accountToolsTableName(),
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(toolId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoAccountToolStore.create(accountId, input);
      throw err;
    }
    return record;
  },

  async update(accountId, toolId, rawPatch: UpdateAccountToolInput) {
    const existing = await dynamoAccountToolStore.getById(accountId, toolId);
    if (!existing || existing.status !== "active") return null;
    const patch = normalizeUpdateAccountToolInput(rawPatch);
    const setExpressions: string[] = ["updatedAt = :updatedAt", "#status = :status"];
    const removeExpressions: string[] = ["deletedAt"];
    const names: Record<string, string> = { "#status": "status" };
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: new Date().toISOString() },
      ":status": { S: "active" },
    };

    if (patch.name !== undefined) {
      setExpressions.push("#name = :name");
      names["#name"] = "name";
      values[":name"] = { S: patch.name };
    }
    if (patch.description !== undefined) {
      setExpressions.push("description = :description");
      values[":description"] = { S: patch.description };
    }
    if (patch.inputSchema !== undefined) {
      setExpressions.push("inputSchema = :inputSchema");
      values[":inputSchema"] = toAttributeValue(patch.inputSchema);
    }
    if (patch.bundleStorageKey !== undefined) {
      setExpressions.push("bundleStorageKey = :bundleStorageKey");
      values[":bundleStorageKey"] = { S: patch.bundleStorageKey };
    }
    if (patch.sha256 !== undefined) {
      setExpressions.push("sha256 = :sha256");
      values[":sha256"] = { S: patch.sha256 };
    }
    if (patch.defaultConfig !== undefined) {
      if (patch.defaultConfig === null) removeExpressions.push("defaultConfig");
      else {
        setExpressions.push("defaultConfig = :defaultConfig");
        values[":defaultConfig"] = toAttributeValue(patch.defaultConfig);
      }
    }

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: accountToolsTableName(),
          Key: { accountId: { S: accountId }, toolId: { S: toolId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(toolId)",
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

  async remove(accountId, toolId) {
    const now = new Date().toISOString();
    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: accountToolsTableName(),
          Key: { accountId: { S: accountId }, toolId: { S: toolId } },
          UpdateExpression: "SET #status = :status, updatedAt = :updatedAt, deletedAt = :deletedAt",
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(toolId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": { S: "deleted" },
            ":updatedAt": { S: now },
            ":deletedAt": { S: now },
          },
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },

  async removeAllForAccount(accountId) {
    const records = await dynamoAccountToolStore.list(accountId);
    await Promise.all(records.map((record) => dynamoAccountToolStore.remove(accountId, record.toolId)));
    return records.length;
  },
};
