/**
 * Dynamo helper tests.
 * Cover reusable client export, conditional-check detection, and attribute conversion here.
 */

import { describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  dynamo,
  fromAttributeValue,
  isConditionalCheckFailed,
  toAttributeValue,
} from "../functions/_shared/dynamo.ts";

describe("dynamo helpers", () => {
  it("exports a shared DynamoDB client", () => {
    expect(dynamo).toBeInstanceOf(DynamoDBClient);
  });

  it("detects conditional check failures from sdk exceptions and named errors", () => {
    const sdkError = new ConditionalCheckFailedException({
      $metadata: {},
      message: "conditional failed",
    });
    const namedError = new Error("conditional failed");
    namedError.name = "ConditionalCheckFailedException";

    expect(isConditionalCheckFailed(sdkError)).toBe(true);
    expect(isConditionalCheckFailed(namedError)).toBe(true);
    expect(isConditionalCheckFailed(new Error("other"))).toBe(false);
    expect(isConditionalCheckFailed("ConditionalCheckFailedException")).toBe(false);
  });

  it("encodes nested values into DynamoDB attribute shapes and omits undefined object fields", () => {
    expect(toAttributeValue({
      name: "alice",
      count: 3,
      active: true,
      empty: null,
      tags: ["ops", 2, false],
      nested: {
        keep: "value",
        skip: undefined,
      },
      skipTopLevel: undefined,
    })).toEqual({
      M: {
        name: { S: "alice" },
        count: { N: "3" },
        active: { BOOL: true },
        empty: { NULL: true },
        tags: {
          L: [
            { S: "ops" },
            { N: "2" },
            { BOOL: false },
          ],
        },
        nested: {
          M: {
            keep: { S: "value" },
          },
        },
      },
    });
  });

  it("stringifies unsupported scalar types when encoding", () => {
    expect(toAttributeValue(12n)).toEqual({ S: "12" });
  });

  it("decodes nested DynamoDB attribute shapes into plain values", () => {
    expect(fromAttributeValue({
      M: {
        name: { S: "alice" },
        count: { N: "3" },
        active: { BOOL: true },
        empty: { NULL: true },
        tags: {
          L: [
            { S: "ops" },
            { N: "2" },
            { BOOL: false },
          ],
        },
        nested: {
          M: {
            keep: { S: "value" },
          },
        },
      },
    })).toEqual({
      name: "alice",
      count: 3,
      active: true,
      empty: null,
      tags: ["ops", 2, false],
      nested: {
        keep: "value",
      },
    });
  });

  it("throws for unsupported attribute shapes", () => {
    expect(() => fromAttributeValue({} as never)).toThrow("Unsupported DynamoDB attribute shape");
  });
});
