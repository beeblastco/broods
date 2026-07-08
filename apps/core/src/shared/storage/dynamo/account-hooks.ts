/**
 * DDB-backed account hook metadata CRUD.
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
  createAccountHookId,
  normalizeCreateAccountHookInput,
  normalizeUpdateAccountHookInput,
  type AccountHookRecord,
} from "../account-hooks.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./client.ts";
import { requireEnv } from "../../env.ts";
import type {
  AccountHookStore,
  CreateAccountHookInput,
  UpdateAccountHookInput,
} from "../types.ts";

function accountHooksTableName(): string {
  return requireEnv("ACCOUNT_HOOKS_TABLE_NAME");
}

function recordToItem(record: AccountHookRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    hookId: { S: record.hookId },
    name: { S: record.name },
    ...(record.description !== undefined ? { description: { S: record.description } } : {}),
    events: toAttributeValue(record.events),
    bundleStorageKey: { S: record.bundleStorageKey },
    sha256: { S: record.sha256 },
    status: { S: record.status },
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
    ...(record.deletedAt ? { deletedAt: { S: record.deletedAt } } : {}),
  };
}

function itemToRecord(item: Record<string, AttributeValue>): AccountHookRecord | null {
  const accountId = item.accountId?.S;
  const hookId = item.hookId?.S;
  const name = item.name?.S;
  const bundleStorageKey = item.bundleStorageKey?.S;
  const sha256 = item.sha256?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (!accountId || !hookId || !name || !bundleStorageKey || !sha256 || !status || !createdAt || !updatedAt || !item.events) {
    return null;
  }
  return {
    accountId,
    hookId,
    name,
    ...(item.description?.S ? { description: item.description.S } : {}),
    events: fromAttributeValue(item.events) as AccountHookRecord["events"],
    bundleStorageKey,
    sha256,
    status: status === "deleted" ? "deleted" : "active",
    createdAt,
    updatedAt,
    ...(item.deletedAt?.S ? { deletedAt: item.deletedAt.S } : {}),
  };
}

export const dynamoAccountHookStore: AccountHookStore = {
  async getById(accountId, hookId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: accountHooksTableName(),
        Key: { accountId: { S: accountId }, hookId: { S: hookId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToRecord(result.Item) : null;
  },

  async list(accountId) {
    const records: AccountHookRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: accountHooksTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToRecord)
          .filter((record): record is AccountHookRecord => record !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records.filter((record) => record.status === "active");
  },

  async create(accountId, input: CreateAccountHookInput) {
    const normalized = normalizeCreateAccountHookInput(input);
    const now = new Date().toISOString();
    const record: AccountHookRecord = {
      accountId,
      hookId: createAccountHookId(),
      name: normalized.name,
      ...(normalized.description !== undefined ? { description: normalized.description } : {}),
      events: normalized.events,
      bundleStorageKey: normalized.bundleStorageKey,
      sha256: normalized.sha256,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: accountHooksTableName(),
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(hookId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoAccountHookStore.create(accountId, input);
      throw err;
    }
    return record;
  },

  async update(accountId, hookId, rawPatch: UpdateAccountHookInput) {
    const existing = await dynamoAccountHookStore.getById(accountId, hookId);
    if (!existing || existing.status !== "active") return null;
    const patch = normalizeUpdateAccountHookInput(rawPatch);
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
      if (patch.description === null) removeExpressions.push("description");
      else {
        setExpressions.push("description = :description");
        values[":description"] = { S: patch.description };
      }
    }
    if (patch.events !== undefined) {
      setExpressions.push("events = :events");
      values[":events"] = toAttributeValue(patch.events);
    }
    if (patch.bundleStorageKey !== undefined) {
      setExpressions.push("bundleStorageKey = :bundleStorageKey");
      values[":bundleStorageKey"] = { S: patch.bundleStorageKey };
    }
    if (patch.sha256 !== undefined) {
      setExpressions.push("sha256 = :sha256");
      values[":sha256"] = { S: patch.sha256 };
    }

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: accountHooksTableName(),
          Key: { accountId: { S: accountId }, hookId: { S: hookId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(hookId)",
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

  async remove(accountId, hookId) {
    const now = new Date().toISOString();
    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: accountHooksTableName(),
          Key: { accountId: { S: accountId }, hookId: { S: hookId } },
          UpdateExpression: "SET #status = :status, updatedAt = :updatedAt, deletedAt = :deletedAt",
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(hookId)",
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
    const records = await dynamoAccountHookStore.list(accountId);
    await Promise.all(records.map((record) => dynamoAccountHookStore.remove(accountId, record.hookId)));
    return records.length;
  },
};
