/**
 * DynamoDB sandbox/workspace config store tests.
 * Stub `dynamo.send` with an in-memory table to exercise the item mappers,
 * encryption-at-rest for sandbox config (envVars/options secrets), plaintext
 * storage for workspace config, and the create/get/list/remove round-trip.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { dynamo, fromAttributeValue } from "../functions/_shared/storage/dynamo/client.ts";
import { dynamoSandboxConfigStore } from "../functions/_shared/storage/dynamo/sandbox-configs.ts";
import { dynamoWorkspaceConfigStore } from "../functions/_shared/storage/dynamo/workspace-configs.ts";

const originalSend = dynamo.send;
const originalSecret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
let store: Map<string, Record<string, AttributeValue>>;

beforeEach(() => {
  // Sandbox config is encrypted at rest, so the suite needs an encryption secret
  // (CI runs `bun test` without one; each encryption-touching test sets its own).
  process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = "test-secret";
  process.env.SANDBOX_CONFIGS_TABLE_NAME = "sandbox-configs";
  process.env.WORKSPACE_CONFIGS_TABLE_NAME = "workspace-configs";
  store = new Map();
  dynamo.send = createInMemorySend(store) as never;
});

afterEach(() => {
  dynamo.send = originalSend;
  if (originalSecret === undefined) delete process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  else process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = originalSecret;
  delete process.env.SANDBOX_CONFIGS_TABLE_NAME;
  delete process.env.WORKSPACE_CONFIGS_TABLE_NAME;
});

describe("dynamo sandbox config store", () => {
  it("encrypts the config at rest and decrypts it on read", async () => {
    const created = await dynamoSandboxConfigStore.create("acct_1", {
      name: "builder",
      config: { provider: "lambda", permissionMode: "bypass", envVars: { TOKEN: "super-secret" } },
    });
    expect(created.sandboxId).toMatch(/^sb_/);

    // At rest the config attribute is the encrypted envelope — never the plaintext secret.
    const rawItem = store.get(`acct_1|${created.sandboxId}`)!;
    const rawConfig = fromAttributeValue(rawItem.config!) as Record<string, unknown>;
    expect(rawConfig.encrypted).toBe(true);
    expect(typeof rawConfig.ciphertext).toBe("string");
    expect(JSON.stringify(rawItem)).not.toContain("super-secret");

    // getById decrypts back to the original plaintext config.
    const fetched = await dynamoSandboxConfigStore.getById("acct_1", created.sandboxId);
    expect(fetched?.config).toEqual({
      provider: "lambda",
      permissionMode: "bypass",
      envVars: { TOKEN: "super-secret" },
    });
  });

  it("lists by account and removes (returning false for a missing id)", async () => {
    const a = await dynamoSandboxConfigStore.create("acct_1", { name: "a", config: { provider: "lambda" } });
    await dynamoSandboxConfigStore.create("acct_2", { name: "b", config: { provider: "lambda" } });

    const listed = await dynamoSandboxConfigStore.list("acct_1");
    expect(listed.map((r) => r.sandboxId)).toEqual([a.sandboxId]);

    expect(await dynamoSandboxConfigStore.remove("acct_1", a.sandboxId)).toBe(true);
    expect(await dynamoSandboxConfigStore.remove("acct_1", "sb_missing")).toBe(false);
    expect(await dynamoSandboxConfigStore.getById("acct_1", a.sandboxId)).toBeNull();
  });
});

describe("dynamo workspace config store", () => {
  it("stores the config in plaintext and round-trips it", async () => {
    const created = await dynamoWorkspaceConfigStore.create("acct_1", {
      name: "notes",
      config: { storage: { provider: "s3" }, harness: { enabled: true } },
    });
    expect(created.workspaceId).toMatch(/^ws_/);

    // No secrets in workspace config: stored verbatim, not encrypted.
    const rawItem = store.get(`acct_1|${created.workspaceId}`)!;
    expect(fromAttributeValue(rawItem.config!)).toEqual({ storage: { provider: "s3" }, harness: { enabled: true } });

    const fetched = await dynamoWorkspaceConfigStore.getById("acct_1", created.workspaceId);
    expect(fetched?.config).toEqual({ storage: { provider: "s3" }, harness: { enabled: true } });
  });
});

/** Minimal in-memory DynamoDB emulating Put/Get/Query/Delete for these stores. */
function createInMemorySend(table: Map<string, Record<string, AttributeValue>>) {
  const keyOf = (attrs: Record<string, AttributeValue>): string => {
    const accountId = attrs.accountId?.S ?? "";
    const id = attrs.sandboxId?.S ?? attrs.workspaceId?.S ?? "";
    return `${accountId}|${id}`;
  };

  const attrs = (value: unknown): Record<string, AttributeValue> => (value ?? {}) as Record<string, AttributeValue>;

  return mock(async (command: PutItemCommand | GetItemCommand | QueryCommand | DeleteItemCommand) => {
    if (command instanceof PutItemCommand) {
      const item = attrs(command.input.Item);
      table.set(keyOf(item), item);
      return {};
    }
    if (command instanceof GetItemCommand) {
      return { Item: table.get(keyOf(attrs(command.input.Key))) };
    }
    if (command instanceof QueryCommand) {
      const accountId = attrs(command.input.ExpressionAttributeValues)[":accountId"]?.S;
      return { Items: [...table.values()].filter((item) => item.accountId?.S === accountId) };
    }
    const k = keyOf(attrs(command.input.Key));
    if (!table.has(k)) {
      throw new ConditionalCheckFailedException({ $metadata: {}, message: "missing" });
    }
    table.delete(k);
    return {};
  });
}
