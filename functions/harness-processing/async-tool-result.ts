/**
 * Async external tool result persistence.
 * Keep tool-call status separate from direct async request status rows.
 */

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../_shared/dynamo.ts";
import { requireEnv } from "../_shared/env.ts";

const ASYNC_TOOL_RESULT_TABLE_NAME = requireEnv("ASYNC_TOOL_RESULT_TABLE_NAME");
const ASYNC_TOOL_RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type AsyncToolStatus = "processing" | "completed" | "failed";

export interface AsyncToolResultRecord {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  status: AsyncToolStatus;
  createdAt: string;
  updatedAt: string;
  response?: unknown;
  error?: string;
  expiresAt: number;
}

export async function createPendingAsyncToolResult(options: {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
}): Promise<boolean> {
  const now = new Date().toISOString();

  try {
    await dynamo.send(new PutItemCommand({
      TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
      Item: {
        resultId: { S: options.resultId },
        parentEventId: { S: options.parentEventId },
        conversationKey: { S: options.conversationKey },
        toolName: { S: options.toolName },
        toolCallId: { S: options.toolCallId },
        input: toAttributeValue(options.input),
        status: { S: "processing" },
        createdAt: { S: now },
        updatedAt: { S: now },
        expiresAt: { N: String(asyncToolResultExpiresAt()) },
      },
      ConditionExpression: "attribute_not_exists(resultId)",
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

export async function getAsyncToolResult(resultId: string): Promise<AsyncToolResultRecord | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: resultId } },
    ConsistentRead: true,
  }));

  return result.Item ? itemToAsyncToolResult(result.Item) : null;
}

export async function markAsyncToolResultCompleted(options: {
  resultId: string;
  response: unknown;
}): Promise<void> {
  await updateAsyncToolResult(options.resultId, "completed", {
    response: options.response,
    error: undefined,
  });
}

export async function markAsyncToolResultFailed(options: {
  resultId: string;
  error: string;
}): Promise<void> {
  await updateAsyncToolResult(options.resultId, "failed", {
    error: options.error,
    response: undefined,
  });
}

function asyncToolResultExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + ASYNC_TOOL_RESULT_TTL_SECONDS;
}

async function updateAsyncToolResult(
  resultId: string,
  status: AsyncToolStatus,
  values: { response?: unknown; error?: string },
): Promise<void> {
  const setExpressions = [
    "#status = :status",
    "updatedAt = :updatedAt",
    "expiresAt = :expiresAt",
    ...(values.response !== undefined ? ["#response = :response"] : []),
    ...(values.error !== undefined ? ["#error = :error"] : []),
  ];
  const removeExpressions = [
    ...(values.response === undefined ? ["#response"] : []),
    ...(values.error === undefined ? ["#error"] : []),
  ];

  await dynamo.send(new UpdateItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: resultId } },
    UpdateExpression: [
      `SET ${setExpressions.join(", ")}`,
      ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
    ].join(" "),
    ExpressionAttributeNames: {
      "#status": "status",
      "#response": "response",
      "#error": "error",
    },
    ExpressionAttributeValues: {
      ":status": { S: status },
      ":updatedAt": { S: new Date().toISOString() },
      ":expiresAt": { N: String(asyncToolResultExpiresAt()) },
      ...(values.response !== undefined ? { ":response": toAttributeValue(values.response) } : {}),
      ...(values.error !== undefined ? { ":error": { S: values.error } } : {}),
    },
  }));
}

function itemToAsyncToolResult(item: Record<string, AttributeValue>): AsyncToolResultRecord | null {
  const resultId = item.resultId?.S;
  const parentEventId = item.parentEventId?.S;
  const conversationKey = item.conversationKey?.S;
  const toolName = item.toolName?.S;
  const toolCallId = item.toolCallId?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  const expiresAtNumber = item.expiresAt?.N ? Number(item.expiresAt.N) : undefined;

  if (
    !resultId ||
    !parentEventId ||
    !conversationKey ||
    !toolName ||
    !toolCallId ||
    !isAsyncToolStatus(status) ||
    !createdAt ||
    !updatedAt ||
    !Number.isFinite(expiresAtNumber)
  ) {
    return null;
  }

  return {
    resultId,
    parentEventId,
    conversationKey,
    toolName,
    toolCallId,
    input: item.input ? fromAttributeValue(item.input) : undefined,
    status,
    createdAt,
    updatedAt,
    response: item.response ? fromAttributeValue(item.response) : undefined,
    error: optionalString(item.error),
    expiresAt: expiresAtNumber as number,
  };
}

function optionalString(value: AttributeValue | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const decoded = fromAttributeValue(value);
  return typeof decoded === "string" ? decoded : undefined;
}

function isAsyncToolStatus(value: string | undefined): value is AsyncToolStatus {
  return value === "processing" || value === "completed" || value === "failed";
}
