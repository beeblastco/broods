/**
 * Async tool result persistence.
 * Keep tool-call status separate from direct async request status rows.
 */

import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../_shared/storage/dynamo/client.ts";
import { requireEnv } from "../_shared/env.ts";

const ASYNC_TOOL_RESULT_TABLE_NAME = requireEnv("ASYNC_TOOL_RESULT_TABLE_NAME");
const ASYNC_TOOL_RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;
// Current fan-in uses one group item inside AsyncToolResult so completion can
// collect every detached async tool from the same parent event without a second
// table. When this path moves to JetStream, replace this index/group tracking
// with stream consumer state instead of maintaining both.
const PARENT_EVENT_ID_INDEX = "ParentEventIdIndex";

export type AsyncToolStatus = "processing" | "completed" | "failed";
export type AsyncToolDelivery =
  | { kind: "async" }
  | {
    kind: "nats";
    connectionId: string;
    publicEventId: string;
    publicConversationKey: string;
  }
  | {
    // Deferred result should be pushed back to the chat channel the turn came
    // from. `source` is the channel's own routing payload (chat/thread id),
    // replayed verbatim into `adapter.actions()` to rebuild a sender — see
    // sendChannelReply in integrations.ts.
    kind: "channel";
    channelName: string;
    source: Record<string, unknown>;
  };

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
  delivery?: AsyncToolDelivery;
  // Set when the model already consumed this result by polling async_status. The
  // resume paths skip auto-injecting an observed result so the model is not handed
  // the same answer twice (poll + injected continuation).
  observed?: boolean;
  expiresAt: number;
}

export interface DetachedAsyncToolGroup {
  parentEventId: string;
  resultIds: string[];
  sealed: boolean;
}

export async function createPendingAsyncToolResult(options: {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  delivery?: AsyncToolDelivery;
  // Per-job secret that authorizes settling this one row from outside the request
  // (sandbox background-job callback). Stored, never returned to the model.
  completionToken?: string;
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
        ...(options.delivery ? { delivery: toAttributeValue(options.delivery) } : {}),
        ...(options.completionToken ? { completionToken: { S: options.completionToken } } : {}),
        status: { S: "processing" },
        createdAt: { S: now },
        updatedAt: { S: now },
        expiresAt: { N: String(asyncToolResultExpiresAt()) },
      },
      ConditionExpression: "attribute_not_exists(resultId)",
    }));
    if (options.delivery) {
      // Delivery is present only for callback-driven work. Register it in the
      // per-parent group so a fast callback cannot continue the parent until the
      // launcher seals the group after all sibling resultIds are known.
      await registerDetachedAsyncTool(options.parentEventId, options.resultId);
    }
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * The per-job completion token for a background-job row, or null. Read in
 * isolation so the secret never rides along on the general result record.
 */
export async function getAsyncToolCompletionToken(resultId: string): Promise<string | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: resultId } },
    ProjectionExpression: "completionToken",
    ConsistentRead: true,
  }));
  return result.Item?.completionToken?.S ?? null;
}

export async function getDetachedAsyncToolGroup(parentEventId: string): Promise<DetachedAsyncToolGroup | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: detachedAsyncToolGroupId(parentEventId) } },
    ConsistentRead: true,
  }));

  return result.Item ? itemToDetachedAsyncToolGroup(result.Item) : null;
}

export async function sealDetachedAsyncToolGroup(parentEventId: string): Promise<DetachedAsyncToolGroup | null> {
  const now = new Date().toISOString();

  const result = await dynamo.send(new UpdateItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: detachedAsyncToolGroupId(parentEventId) } },
    UpdateExpression: "SET #sealed = :sealed, updatedAt = :updatedAt, expiresAt = :expiresAt",
    ExpressionAttributeNames: {
      "#sealed": "sealed",
    },
    ExpressionAttributeValues: {
      ":sealed": { BOOL: true },
      ":updatedAt": { S: now },
      ":expiresAt": { N: String(asyncToolResultExpiresAt()) },
    },
    ReturnValues: "ALL_NEW",
  }));

  return result.Attributes ? itemToDetachedAsyncToolGroup(result.Attributes) : null;
}

export async function listAsyncToolResultsByParentEvent(parentEventId: string): Promise<AsyncToolResultRecord[]> {
  const records: AsyncToolResultRecord[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
      IndexName: PARENT_EVENT_ID_INDEX,
      KeyConditionExpression: "parentEventId = :parentEventId",
      ExpressionAttributeValues: {
        ":parentEventId": { S: parentEventId },
      },
      ConsistentRead: false,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }));

    records.push(
      ...(result.Items ?? [])
        .map(itemToAsyncToolResult)
        .filter((record): record is AsyncToolResultRecord => record !== null),
    );
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

async function registerDetachedAsyncTool(parentEventId: string, resultId: string): Promise<void> {
  const now = new Date().toISOString();
  const setExpressions = [
    "parentEventId = :parentEventId",
    "itemType = :itemType",
    "#sealed = if_not_exists(#sealed, :notSealed)",
    "updatedAt = :updatedAt",
    "expiresAt = :expiresAt",
  ];

  await dynamo.send(new UpdateItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: detachedAsyncToolGroupId(parentEventId) } },
    UpdateExpression: `SET ${setExpressions.join(", ")} ADD resultIds :resultIds`,
    ExpressionAttributeNames: {
      "#sealed": "sealed",
    },
    ExpressionAttributeValues: {
      ":parentEventId": { S: parentEventId },
      ":itemType": { S: "detached-async-tool-group" },
      ":notSealed": { BOOL: false },
      ":updatedAt": { S: now },
      ":expiresAt": { N: String(asyncToolResultExpiresAt()) },
      ":resultIds": { SS: [resultId] },
    },
  }));
}

function detachedAsyncToolGroupId(parentEventId: string): string {
  return `${parentEventId}:async-tool-detached-group`;
}

export async function getAsyncToolResult(resultId: string): Promise<AsyncToolResultRecord | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: resultId } },
    ConsistentRead: true,
  }));

  return result.Item ? itemToAsyncToolResult(result.Item) : null;
}

/**
 * Mark a result as observed: the model already saw its terminal value through an
 * async_status poll, so the auto-delivery resume must not inject it again. Safe to
 * call once the row is settled; a still-processing row is never marked observed.
 */
export async function markAsyncToolResultObserved(resultId: string): Promise<void> {
  await dynamo.send(new UpdateItemCommand({
    TableName: ASYNC_TOOL_RESULT_TABLE_NAME,
    Key: { resultId: { S: resultId } },
    UpdateExpression: "SET observed = :observed, updatedAt = :updatedAt, expiresAt = :expiresAt",
    ExpressionAttributeValues: {
      ":observed": { BOOL: true },
      ":updatedAt": { S: new Date().toISOString() },
      ":expiresAt": { N: String(asyncToolResultExpiresAt()) },
    },
  }));
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

export async function settleAsyncToolResultFromCallback(options: {
  resultId: string;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}): Promise<AsyncToolResultRecord | null> {
  try {
    const result = await updateAsyncToolResult(options.resultId, options.status, {
      response: options.status === "completed" ? options.response : undefined,
      error: options.status === "failed" ? options.error ?? "Async tool call failed" : undefined,
    }, {
      onlyWhenProcessing: true,
      returnUpdated: true,
    });

    return result.Item ? itemToAsyncToolResult(result.Item) : null;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return null;
    }
    throw err;
  }
}

async function updateAsyncToolResult(
  resultId: string,
  status: AsyncToolStatus,
  values: { response?: unknown; error?: string },
  options: { onlyWhenProcessing?: boolean; returnUpdated?: boolean } = {},
): Promise<{ Item?: Record<string, AttributeValue> }> {
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

  const result = await dynamo.send(new UpdateItemCommand({
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
      ...(options.onlyWhenProcessing ? { ":processing": { S: "processing" } } : {}),
      ...(values.response !== undefined ? { ":response": toAttributeValue(values.response) } : {}),
      ...(values.error !== undefined ? { ":error": { S: values.error } } : {}),
    },
    ...(options.onlyWhenProcessing ? { ConditionExpression: "#status = :processing" } : {}),
    ...(options.returnUpdated ? { ReturnValues: "ALL_NEW" } : {}),
  }));
  return { Item: result?.Attributes };
}

function asyncToolResultExpiresAt(): number {
  return Math.floor(Date.now() / 1000) + ASYNC_TOOL_RESULT_TTL_SECONDS;
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
    delivery: optionalDelivery(item.delivery),
    ...(item.observed?.BOOL === true ? { observed: true } : {}),
    expiresAt: expiresAtNumber as number,
  };
}

function itemToDetachedAsyncToolGroup(item: Record<string, AttributeValue>): DetachedAsyncToolGroup | null {
  const parentEventId = item.parentEventId?.S;
  const resultIds = item.resultIds?.SS;
  const sealed = item.sealed?.BOOL;

  if (!parentEventId || !resultIds || sealed === undefined) {
    return null;
  }

  return {
    parentEventId,
    resultIds: [...resultIds].sort(),
    sealed,
  };
}

function optionalDelivery(value: AttributeValue | undefined): AsyncToolDelivery | undefined {
  if (!value) {
    return undefined;
  }

  const decoded = fromAttributeValue(value);
  if (!decoded || typeof decoded !== "object") {
    return undefined;
  }

  const candidate = decoded as Record<string, unknown>;
  if (candidate.kind === "async") {
    return { kind: "async" };
  }

  if (
    candidate.kind === "nats" &&
    typeof candidate.connectionId === "string" &&
    typeof candidate.publicEventId === "string" &&
    typeof candidate.publicConversationKey === "string"
  ) {
    return {
      kind: "nats",
      connectionId: candidate.connectionId,
      publicEventId: candidate.publicEventId,
      publicConversationKey: candidate.publicConversationKey,
    };
  }

  if (
    candidate.kind === "channel" &&
    typeof candidate.channelName === "string" &&
    candidate.source !== null &&
    typeof candidate.source === "object"
  ) {
    return {
      kind: "channel",
      channelName: candidate.channelName,
      source: candidate.source as Record<string, unknown>,
    };
  }

  return undefined;
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
