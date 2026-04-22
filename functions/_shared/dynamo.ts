/**
 * Shared DynamoDB primitives.
 * Keep reusable client setup and low-level attribute helpers here.
 */

import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";

export const dynamo = new DynamoDBClient({ requestHandler: new FetchHttpHandler() });

export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException
    || (err instanceof Error && err.name === "ConditionalCheckFailedException");
}

export function toAttributeValue(value: unknown): AttributeValue {
  if (value == null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };

  if (Array.isArray(value)) {
    return { L: value.map((entry) => toAttributeValue(entry)) };
  }

  if (typeof value === "object") {
    return {
      M: Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) =>
          entry === undefined ? [] : [[key, toAttributeValue(entry)]],
        ),
      ),
    };
  }

  return { S: String(value) };
}

export function fromAttributeValue(value: AttributeValue): unknown {
  if ("NULL" in value && value.NULL) return null;
  if ("S" in value && value.S !== undefined) return value.S;
  if ("N" in value && value.N !== undefined) return Number(value.N);
  if ("BOOL" in value && value.BOOL !== undefined) return value.BOOL;

  if ("L" in value && value.L !== undefined) {
    return value.L.map((entry) => fromAttributeValue(entry));
  }

  if ("M" in value && value.M !== undefined) {
    return Object.fromEntries(
      Object.entries(value.M).map(([key, entry]) => [key, fromAttributeValue(entry)]),
    );
  }

  throw new Error("Unsupported DynamoDB attribute shape");
}
