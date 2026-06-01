/**
 * DDB-backed sandbox config CRUD. Input normalization + the public projection
 * live in `../sandbox-config.ts` and are called at create/update so both the
 * DynamoDB and Convex stores enforce the same contract. The config blob is
 * encrypted at rest (it may carry envVars / option secrets).
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
  decodeStoredConfigObject,
  encryptConfigObject,
} from "../agent-config.ts";
import {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  type SandboxConfig,
} from "../sandbox-config.ts";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "./client.ts";
import { requireEnv } from "../../env.ts";
import type {
  CreateSandboxConfigInput,
  SandboxConfigRecord,
  SandboxConfigStore,
  UpdateSandboxConfigInput,
} from "../types.ts";

function sandboxConfigsTableName(): string {
  return requireEnv("SANDBOX_CONFIGS_TABLE_NAME");
}

function createSandboxId(): string {
  return `sb_${randomBytes(12).toString("hex")}`;
}

function recordToItem(record: SandboxConfigRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: record.accountId },
    sandboxId: { S: record.sandboxId },
    name: { S: record.name },
    ...(record.description ? { description: { S: record.description } } : {}),
    config: toAttributeValue(encryptConfigObject(record.config)),
    createdAt: { S: record.createdAt },
    updatedAt: { S: record.updatedAt },
  };
}

function itemToRecord(item: Record<string, AttributeValue>): SandboxConfigRecord | null {
  const accountId = item.accountId?.S;
  const sandboxId = item.sandboxId?.S;
  const name = item.name?.S;
  const description = item.description?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (!accountId || !sandboxId || !name || !createdAt || !updatedAt || !item.config) {
    return null;
  }
  return {
    accountId,
    sandboxId,
    name,
    ...(description ? { description } : {}),
    config: decodeStoredConfigObject(fromAttributeValue(item.config)) as unknown as SandboxConfig,
    createdAt,
    updatedAt,
  };
}

export const dynamoSandboxConfigStore: SandboxConfigStore = {
  async getById(accountId, sandboxId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: sandboxConfigsTableName(),
        Key: { accountId: { S: accountId }, sandboxId: { S: sandboxId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToRecord(result.Item) : null;
  },

  async list(accountId) {
    const records: SandboxConfigRecord[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await dynamo.send(
        new QueryCommand({
          TableName: sandboxConfigsTableName(),
          KeyConditionExpression: "accountId = :accountId",
          ExpressionAttributeValues: { ":accountId": { S: accountId } },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      records.push(
        ...(result.Items ?? [])
          .map(itemToRecord)
          .filter((r): r is SandboxConfigRecord => r !== null),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  },

  async create(accountId, input: CreateSandboxConfigInput) {
    const normalized = normalizeCreateSandboxConfigInput(input);
    const now = new Date().toISOString();
    const record: SandboxConfigRecord = {
      accountId,
      sandboxId: createSandboxId(),
      name: normalized.name,
      ...(normalized.description ? { description: normalized.description } : {}),
      config: normalized.config,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: sandboxConfigsTableName(),
          Item: recordToItem(record),
          ConditionExpression: "attribute_not_exists(accountId) AND attribute_not_exists(sandboxId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoSandboxConfigStore.create(accountId, input);
      throw err;
    }
    return record;
  },

  async update(accountId, sandboxId, rawPatch: UpdateSandboxConfigInput) {
    const existing = await dynamoSandboxConfigStore.getById(accountId, sandboxId);
    if (!existing) return null;
    const patch = normalizeUpdateSandboxConfigInput(existing.config, rawPatch);
    const setExpressions: string[] = ["updatedAt = :updatedAt"];
    const removeExpressions: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, AttributeValue> = {
      ":updatedAt": { S: new Date().toISOString() },
    };

    if (patch.config !== undefined) {
      setExpressions.push("#config = :config");
      names["#config"] = "config";
      values[":config"] = toAttributeValue(encryptConfigObject(patch.config));
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
          TableName: sandboxConfigsTableName(),
          Key: { accountId: { S: accountId }, sandboxId: { S: sandboxId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(sandboxId)",
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

  async remove(accountId, sandboxId) {
    const result = await dynamo
      .send(
        new DeleteItemCommand({
          TableName: sandboxConfigsTableName(),
          Key: { accountId: { S: accountId }, sandboxId: { S: sandboxId } },
          ConditionExpression: "attribute_exists(accountId) AND attribute_exists(sandboxId)",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },

  async removeAllForAccount(accountId) {
    const records = await dynamoSandboxConfigStore.list(accountId);
    await Promise.all(records.map((r) => dynamoSandboxConfigStore.remove(accountId, r.sandboxId)));
    return records.length;
  },
};
