/**
 * DDB-backed account CRUD lifted from _shared/accounts.ts.
 * Behaviour is byte-identical — the original file now routes through
 * getStorage().accounts so SaaS mode (Convex) is exercised on the same
 * code paths.
 */

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { dynamo, isConditionalCheckFailed } from "./client.ts";
import { optionalEnv, requireEnv } from "../../env.ts";
import {
  createAccountId,
  createAccountSecret,
  hashAccountSecret,
  normalizeCreateAccountInput,
  normalizeUpdateAccountInput,
} from "../accounts.ts";
import type {
  AccountRecord,
  AccountStatus,
  AccountStore,
} from "../types.ts";

const DEFAULT_ACCOUNT_STATUS: AccountStatus = "active";

function accountConfigsTableName(): string {
  return requireEnv("ACCOUNT_CONFIGS_TABLE_NAME");
}

function accountSecretIndexName(): string {
  return optionalEnv("ACCOUNT_SECRET_INDEX_NAME") ?? "SecretHashIndex";
}

function accountToItem(account: AccountRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: account.accountId },
    username: { S: account.username },
    ...(account.description ? { description: { S: account.description } } : {}),
    secretHash: { S: account.secretHash },
    status: { S: account.status },
    createdAt: { S: account.createdAt },
    updatedAt: { S: account.updatedAt },
  };
}

function itemToAccount(item: Record<string, AttributeValue>): AccountRecord | null {
  const accountId = item.accountId?.S;
  const username = item.username?.S ?? accountId;
  const description = item.description?.S;
  const secretHash = item.secretHash?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  if (!accountId || !username || !secretHash || !isAccountStatus(status) || !createdAt || !updatedAt) {
    return null;
  }
  return {
    accountId,
    username,
    ...(description ? { description } : {}),
    secretHash,
    status,
    createdAt,
    updatedAt,
  };
}

function isAccountStatus(value: string | undefined): value is AccountStatus {
  return value === "active" || value === "disabled";
}

export const dynamoAccountStore: AccountStore = {
  async getById(accountId) {
    const result = await dynamo.send(
      new GetItemCommand({
        TableName: accountConfigsTableName(),
        Key: { accountId: { S: accountId } },
        ConsistentRead: true,
      }),
    );
    return result.Item ? itemToAccount(result.Item) : null;
  },

  async getBySecretHash(secretHash) {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: accountConfigsTableName(),
        IndexName: accountSecretIndexName(),
        KeyConditionExpression: "secretHash = :secretHash",
        ExpressionAttributeValues: { ":secretHash": { S: secretHash } },
        Limit: 1,
      }),
    );
    const item = result.Items?.[0];
    return item ? itemToAccount(item) : null;
  },

  async list() {
    const result = await dynamo.send(
      new ScanCommand({ TableName: accountConfigsTableName(), ConsistentRead: true }),
    );
    return (result.Items ?? [])
      .map(itemToAccount)
      .filter((a): a is AccountRecord => a !== null);
  },

  async create(input) {
    const normalized = normalizeCreateAccountInput(input);
    const accountId = createAccountId();
    const accountSecret = createAccountSecret();
    const now = new Date().toISOString();
    const account: AccountRecord = {
      accountId,
      username: normalized.username,
      ...(normalized.description ? { description: normalized.description } : {}),
      secretHash: hashAccountSecret(accountSecret),
      status: DEFAULT_ACCOUNT_STATUS,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await dynamo.send(
        new PutItemCommand({
          TableName: accountConfigsTableName(),
          Item: accountToItem(account),
          ConditionExpression: "attribute_not_exists(accountId)",
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) return dynamoAccountStore.create(input);
      throw err;
    }
    return { account, secret: accountSecret };
  },

  async update(accountId, patch) {
    const normalized = normalizeUpdateAccountInput(patch);
    const existing = await dynamoAccountStore.getById(accountId);
    if (!existing) return null;

    const setExpressions = [
      "updatedAt = :updatedAt",
      ...(normalized.username !== undefined ? ["username = :username"] : []),
      ...(normalized.description !== undefined && normalized.description !== null
        ? ["description = :description"]
        : []),
    ];
    const removeExpressions = normalized.description === null ? ["description"] : [];

    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: accountConfigsTableName(),
          Key: { accountId: { S: accountId } },
          UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
          ].join(" "),
          ConditionExpression: "attribute_exists(accountId)",
          ExpressionAttributeValues: {
            ":updatedAt": { S: new Date().toISOString() },
            ...(normalized.username !== undefined ? { ":username": { S: normalized.username } } : {}),
            ...(normalized.description !== undefined && normalized.description !== null
              ? { ":description": { S: normalized.description } }
              : {}),
          },
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      });

    return result?.Attributes ? itemToAccount(result.Attributes) : null;
  },

  async rotateSecret(accountId) {
    const accountSecret = createAccountSecret();
    const result = await dynamo
      .send(
        new UpdateItemCommand({
          TableName: accountConfigsTableName(),
          Key: { accountId: { S: accountId } },
          UpdateExpression: "SET secretHash = :secretHash, updatedAt = :updatedAt",
          ConditionExpression: "attribute_exists(accountId)",
          ExpressionAttributeValues: {
            ":secretHash": { S: hashAccountSecret(accountSecret) },
            ":updatedAt": { S: new Date().toISOString() },
          },
          ReturnValues: "ALL_NEW",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      });
    const account = result?.Attributes ? itemToAccount(result.Attributes) : null;
    return account ? { account, secret: accountSecret } : null;
  },

  async remove(accountId) {
    const result = await dynamo
      .send(
        new DeleteItemCommand({
          TableName: accountConfigsTableName(),
          Key: { accountId: { S: accountId } },
          ConditionExpression: "attribute_exists(accountId)",
        }),
      )
      .catch((err) => {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      });
    return result !== false;
  },
};
