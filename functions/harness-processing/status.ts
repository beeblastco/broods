/**
 * Async direct API status persistence.
 * Keep polling state separate from conversation/session storage.
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
import type { ToolApprovalSummary } from "./harness.ts";

const ASYNC_RESULTS_TABLE_NAME = requireEnv("ASYNC_RESULTS_TABLE_NAME");
const ASYNC_RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type AsyncStatus = "processing" | "awaiting_approval" | "completed" | "failed";

export interface AsyncResultRecord {
  eventId: string;
  conversationKey: string;
  status: AsyncStatus;
  createdAt: string;
  updatedAt: string;
  response?: string;
  error?: string;
  approvals?: ToolApprovalSummary[];
  expiresAt: number;
}

export async function createPendingAsyncResult(options: {
  eventId: string;
  conversationKey: string;
}): Promise<boolean> {
  const now = new Date().toISOString();

  try {
    await dynamo.send(new PutItemCommand({
      TableName: ASYNC_RESULTS_TABLE_NAME,
      Item: {
        eventId: { S: options.eventId },
        conversationKey: { S: options.conversationKey },
        status: { S: "processing" },
        createdAt: { S: now },
        updatedAt: { S: now },
        expiresAt: { N: String(asyncResultExpiresAt()) },
      },
      ConditionExpression: "attribute_not_exists(eventId)",
    }));
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

export async function getAsyncResult(eventId: string): Promise<AsyncResultRecord | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: ASYNC_RESULTS_TABLE_NAME,
    Key: { eventId: { S: eventId } },
    ConsistentRead: true,
  }));

  return result.Item ? itemToAsyncResult(result.Item) : null;
}

export async function markAsyncResultCompleted(options: {
  eventId: string;
  response: string;
}): Promise<void> {
  await updateAsyncResult(options.eventId, "completed", {
    response: options.response,
    error: undefined,
    approvals: undefined,
  });
}

export async function markAsyncResultFailed(options: {
  eventId: string;
  error: string;
}): Promise<void> {
  await updateAsyncResult(options.eventId, "failed", {
    error: options.error,
    response: undefined,
    approvals: undefined,
  });
}

export async function markAsyncResultAwaitingApproval(options: {
  eventId: string;
  approvals: ToolApprovalSummary[];
}): Promise<void> {
  await updateAsyncResult(options.eventId, "awaiting_approval", {
    approvals: options.approvals,
    response: undefined,
    error: undefined,
  });
}

function asyncResultExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + ASYNC_RESULT_TTL_SECONDS;
}

async function updateAsyncResult(
  eventId: string,
  status: AsyncStatus,
  values: { response?: string; error?: string; approvals?: ToolApprovalSummary[] },
): Promise<void> {
  const setExpressions = [
    "#status = :status",
    "updatedAt = :updatedAt",
    "expiresAt = :expiresAt",
    ...(values.response !== undefined ? ["#response = :response"] : []),
    ...(values.error !== undefined ? ["#error = :error"] : []),
    ...(values.approvals !== undefined ? ["approvals = :approvals"] : []),
  ];
  const removeExpressions = [
    ...(values.response === undefined ? ["#response"] : []),
    ...(values.error === undefined ? ["#error"] : []),
    ...(values.approvals === undefined ? ["approvals"] : []),
  ];

  await dynamo.send(new UpdateItemCommand({
    TableName: ASYNC_RESULTS_TABLE_NAME,
    Key: { eventId: { S: eventId } },
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
      ":expiresAt": { N: String(asyncResultExpiresAt()) },
      ...(values.response !== undefined ? { ":response": { S: values.response } } : {}),
      ...(values.error !== undefined ? { ":error": { S: values.error } } : {}),
      ...(values.approvals !== undefined ? { ":approvals": toAttributeValue(values.approvals) } : {}),
    },
  }));
}

function itemToAsyncResult(item: Record<string, AttributeValue>): AsyncResultRecord | null {
  const eventId = item.eventId?.S;
  const conversationKey = item.conversationKey?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;
  const expiresAtNumber = item.expiresAt?.N ? Number(item.expiresAt.N) : undefined;

  if (
    !eventId ||
    !conversationKey ||
    !isAsyncStatus(status) ||
    !createdAt ||
    !updatedAt ||
    !Number.isFinite(expiresAtNumber)
  ) {
    return null;
  }

  const expiresAt = expiresAtNumber as number;

  return {
    eventId,
    conversationKey,
    status,
    createdAt,
    updatedAt,
    response: optionalString(item.response),
    error: optionalString(item.error),
    approvals: optionalApprovals(item.approvals),
    expiresAt,
  };
}

function optionalString(value: AttributeValue | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const decoded = fromAttributeValue(value);
  return typeof decoded === "string" ? decoded : undefined;
}

function isAsyncStatus(value: string | undefined): value is AsyncStatus {
  return value === "processing" || value === "awaiting_approval" || value === "completed" || value === "failed";
}

function optionalApprovals(value: AttributeValue | undefined): ToolApprovalSummary[] | undefined {
  if (!value) {
    return undefined;
  }

  const decoded = fromAttributeValue(value);
  if (!Array.isArray(decoded)) {
    return undefined;
  }

  return decoded.filter(isToolApprovalSummary);
}

function isToolApprovalSummary(value: unknown): value is ToolApprovalSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as ToolApprovalSummary;
  return typeof candidate.approvalId === "string" &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.toolName === "string" &&
    "input" in candidate;
}
