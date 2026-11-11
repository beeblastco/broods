import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConvexHttpClient as ClientClass } from "convex/browser";
import type { getFunctionName as NameOf } from "convex/server";
import {
  AccountCipher,
  createWrappedAccountKey,
  type BlobScope,
  type WrappedAccountKey,
} from "../../../../packages/convex/model/envelope.ts";
import { resetAccountKeysForTests } from "../../../../apps/core/src/shared/convex/account-keys.ts";
import { resetConvexClientForTests } from "../../../../apps/core/src/shared/convex/client.ts";
import { convexStorage } from "../../../../apps/core/src/shared/convex/storage.ts";

const CORE_DIR = `${import.meta.dir}/../../../../apps/core/src/shared`;
const { ConvexHttpClient } = (await import(
  Bun.resolveSync("convex/browser", CORE_DIR)
)) as { ConvexHttpClient: typeof ClientClass };
const { getFunctionName } = (await import(
  Bun.resolveSync("convex/server", CORE_DIR)
)) as { getFunctionName: typeof NameOf };

const SECRET = "storage-test-secret";
const ACCOUNT = "acct_store";
const CREATED = Date.UTC(2026, 0, 2, 3, 4, 5);
const UPDATED = Date.UTC(2026, 5, 7, 8, 9, 10);
const CREATED_ISO = "2026-01-02T03:04:05.000Z";
const UPDATED_ISO = "2026-06-07T08:09:10.000Z";

type Args = Record<string, unknown>;
type Answer = (args: Args) => unknown;
type Fake = (
  ref: Parameters<typeof getFunctionName>[0],
  args: Args,
) => Promise<unknown>;

const answers = new Map<string, Answer>();
const calls: string[] = [];
const realQuery = ConvexHttpClient.prototype.query;
const realMutation = ConvexHttpClient.prototype.mutation;
let keys: WrappedAccountKey[] = [];

function answer(name: string, value: unknown): void {
  answers.set(name, (): unknown => value);
}

async function sealed(
  scope: BlobScope,
  value: Record<string, unknown>,
): Promise<{
  encryptedConfig: string;
  encryptionIv: string;
  encryptionTag: string;
}> {
  const blob = await new AccountCipher(ACCOUNT, [SECRET], keys).encrypt(
    scope,
    value,
  );

  return {
    encryptedConfig: blob.ciphertext,
    encryptionIv: blob.iv,
    encryptionTag: blob.tag,
  };
}

function fake(kind: string): Fake {
  return async (ref, args): Promise<unknown> => {
    const name = getFunctionName(ref);
    calls.push(name);
    const handler = answers.get(name);
    if (!handler) throw new Error(`unexpected ${kind} ${name}`);

    return handler(args);
  };
}

beforeEach(async (): Promise<void> => {
  process.env.CONVEX_URL = "https://example.convex.cloud";
  process.env.CONVEX_DEPLOY_KEY = "deploy-key";
  process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = SECRET;
  keys = [await createWrappedAccountKey(ACCOUNT, [SECRET])];
  resetConvexClientForTests();
  resetAccountKeysForTests();
  ConvexHttpClient.prototype.query = fake("query") as never;
  ConvexHttpClient.prototype.mutation = fake("mutation") as never;
  answer("account/keys:list", keys);
});

afterEach((): void => {
  ConvexHttpClient.prototype.query = realQuery;
  ConvexHttpClient.prototype.mutation = realMutation;
  answers.clear();
  calls.length = 0;
  resetConvexClientForTests();
  resetAccountKeysForTests();
});

describe("accounts and crons", (): void => {
  test("an account row becomes a record with ISO dates and optional description", async (): Promise<void> => {
    const row = {
      _id: ACCOUNT,
      orgId: "org",
      username: "ada",
      secretHash: "hash",
      status: "active",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("account/accounts:getById", row);
    expect(await convexStorage.accounts.getById(ACCOUNT)).toEqual({
      accountId: ACCOUNT,
      username: "ada",
      secretHash: "hash",
      status: "active",
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
    });
    answer("runtimeLookups:accountBySecretHash", {
      ...row,
      description: "builder",
      status: "disabled",
    });
    expect(await convexStorage.accounts.getBySecretHash("hash")).toMatchObject({
      description: "builder",
      status: "disabled",
    });
    answer("account/accounts:getById", null);
    expect(await convexStorage.accounts.getById("gone")).toBeNull();
  });

  test("a cron row keeps only the fields that are set", async (): Promise<void> => {
    const base = {
      _id: "cron_1",
      accountId: ACCOUNT,
      name: "nightly",
      agentId: "agent_1",
      events: [],
      scheduleExpression: "rate(1 day)",
      status: "active",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("agent/crons:getById", base);
    expect(await convexStorage.crons.getById(ACCOUNT, "cron_1")).toEqual({
      accountId: ACCOUNT,
      cronId: "cron_1",
      name: "nightly",
      agentId: "agent_1",
      events: [],
      scheduleExpression: "rate(1 day)",
      status: "active",
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
    });
    answer("agent/crons:list", [
      {
        ...base,
        description: "d",
        conversationKey: "key",
        timezone: "UTC",
        lastInvokedAt: CREATED,
        lastStatus: "failed",
        lastError: "boom",
      },
    ]);
    expect(await convexStorage.crons.list(ACCOUNT)).toEqual([
      expect.objectContaining({
        description: "d",
        conversationKey: "key",
        timezone: "UTC",
        lastInvokedAt: CREATED_ISO,
        lastStatus: "failed",
        lastError: "boom",
      }),
    ]);
  });
});

describe("encrypted configs", (): void => {
  const agentRow = {
    _id: "agent_1",
    accountId: ACCOUNT,
    name: "helper",
    createdAt: CREATED,
    updatedAt: UPDATED,
  };

  test("an agent without a stored blob has an empty config", async (): Promise<void> => {
    answer("runtimeLookups:agentById", agentRow);
    expect(await convexStorage.agents.getById(ACCOUNT, "agent_1")).toEqual({
      accountId: ACCOUNT,
      agentId: "agent_1",
      name: "helper",
      config: {},
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
    });
    answer("runtimeLookups:agentById", null);
    expect(await convexStorage.agents.getById(ACCOUNT, "none")).toBeNull();
    expect(calls).not.toContain("account/keys:list");
  });

  test("an agent's blob is decrypted with the account's keys", async (): Promise<void> => {
    const config = { model: { provider: "deepseek" } };
    answer("agent/agents:list", [
      {
        ...agentRow,
        description: "d",
        requireUserToken: true,
        ...(await sealed("agents:encryptedConfig", config)),
      },
      { ...agentRow, _id: "agent_2", requireUserToken: false },
    ]);
    const listed = await convexStorage.agents.listForAccount(ACCOUNT);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      agentId: "agent_1",
      description: "d",
      config: config,
      requireUserToken: true,
    });
    expect(listed[1]).not.toHaveProperty("requireUserToken");
    expect(
      calls.filter((name): boolean => name === "account/keys:list"),
    ).toHaveLength(1);
  });

  test("a blob sealed for another column is refused", async (): Promise<void> => {
    answer("runtimeLookups:agentById", {
      ...agentRow,
      ...(await sealed("sandboxConfigs:encryptedConfig", { a: 1 })),
    });
    await expect(
      convexStorage.agents.getById(ACCOUNT, "agent_1"),
    ).rejects.toThrow("does not decrypt");
  });

  test("a sandbox config falls back to deny-all and otherwise decrypts", async (): Promise<void> => {
    const row = {
      _id: "sbx_1",
      accountId: ACCOUNT,
      name: "box",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("runtimeLookups:sandboxConfigById", row);
    expect(
      await convexStorage.sandboxConfigs.getById(ACCOUNT, "sbx_1"),
    ).toEqual({
      accountId: ACCOUNT,
      sandboxId: "sbx_1",
      name: "box",
      config: {
        provider: "sandbox",
        permissionMode: "ask",
        network: { mode: "deny-all" },
      },
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
    });
    const config = { provider: "sandbox", permissionMode: "allow" };
    answer("sandbox/configs:list", [
      {
        ...row,
        projectId: "p",
        stageId: "s",
        description: "d",
        ...(await sealed("sandboxConfigs:encryptedConfig", config)),
      },
    ]);
    expect(await convexStorage.sandboxConfigs.list(ACCOUNT)).toEqual([
      expect.objectContaining({
        projectId: "p",
        stageId: "s",
        description: "d",
        config: config,
      }),
    ]);
    answer("runtimeLookups:sandboxConfigById", null);
    expect(await convexStorage.sandboxConfigs.getById(ACCOUNT, "x")).toBeNull();
  });
});

describe("workspace and channel rows", (): void => {
  const workspace = {
    _id: "ws_1",
    accountId: ACCOUNT,
    name: "files",
    createdAt: CREATED,
    updatedAt: UPDATED,
  };

  test("only r2 and assumeRole storage learn their owner", async (): Promise<void> => {
    const owner = { accountId: ACCOUNT, workspaceId: "ws_1" };
    answer("workspace/configs:list", [
      { ...workspace, config: undefined },
      { ...workspace, config: { storage: { provider: "s3" } } },
      {
        ...workspace,
        description: "d",
        config: { storage: { provider: "s3", auth: { type: "r2" } } },
      },
      {
        ...workspace,
        config: { storage: { provider: "s3", auth: { type: "assumeRole" } } },
      },
    ]);
    const records = await convexStorage.workspaceConfigs.list(ACCOUNT);
    expect(records.map((record): unknown => record.config)).toEqual([
      { storage: { provider: "s3" } },
      { storage: { provider: "s3" } },
      { storage: { provider: "s3", auth: { type: "r2" }, owner: owner } },
      {
        storage: { provider: "s3", auth: { type: "assumeRole" }, owner: owner },
      },
    ]);
    expect(records[2]?.description).toBe("d");
    answer("workspace/configs:getById", { ...workspace, config: {} });
    expect(
      (await convexStorage.workspaceConfigs.getById(ACCOUNT, "ws_1"))?.config,
    ).toEqual({});
    answer("workspace/configs:getById", null);
    expect(
      await convexStorage.workspaceConfigs.getById(ACCOUNT, "none"),
    ).toBeNull();
  });

  test("a channel record defaults its config and keeps optional fields", async (): Promise<void> => {
    const row = {
      _id: "chan_1",
      accountId: ACCOUNT,
      platform: "slack",
      externalId: "T1",
      name: "team",
      config: undefined,
      status: "active",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("channel/records:getById", row);
    expect(
      await convexStorage.channelRecords.getById(ACCOUNT, "chan_1"),
    ).toEqual({
      accountId: ACCOUNT,
      channelRecordId: "chan_1",
      platform: "slack",
      externalId: "T1",
      name: "team",
      config: { agentBindings: [] },
      status: "active",
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
    });
    answer("channel/records:getById", {
      ...row,
      workspaceRef: "ref",
      description: "d",
      config: { agentBindings: [{ agentId: "a" }] },
    });
    expect(
      await convexStorage.channelRecords.getById(ACCOUNT, "chan_1"),
    ).toEqual(
      expect.objectContaining({
        workspaceRef: "ref",
        description: "d",
        config: { agentBindings: [{ agentId: "a" }] },
      }),
    );
    answer("channel/records:getById", null);
    expect(
      await convexStorage.channelRecords.getById(ACCOUNT, "none"),
    ).toBeNull();
  });
});

describe("mcp, policy and hook rows", (): void => {
  test("an mcp row copies set fields, even falsy ones", async (): Promise<void> => {
    const row = {
      _id: "mcp_1",
      accountId: ACCOUNT,
      projectId: "p",
      stageId: "s",
      name: "tools",
      transport: "http",
      status: "active",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("account/mcp:getById", row);
    expect(await convexStorage.mcp.getById(ACCOUNT, "mcp_1")).toEqual({
      accountId: ACCOUNT,
      serverId: "mcp_1",
      projectId: "p",
      stageId: "s",
      name: "tools",
      transport: "http",
      status: "active",
      createdAt: CREATED_ISO,
      updatedAt: UPDATED_ISO,
    });
    answer("account/mcp:getById", {
      ...row,
      description: "",
      workersCompatible: false,
      runtime: "workers",
      url: "https://m.test",
      sandbox: "sbx",
      command: ["run"],
      bundleStorageKey: "k",
      sha256: "abc",
      headers: { a: "b" },
      oauth: { clientId: "c" },
      allowedTools: [],
      disabled: false,
      deletedAt: UPDATED,
    });
    expect(await convexStorage.mcp.getById(ACCOUNT, "mcp_1")).toMatchObject({
      description: "",
      workersCompatible: false,
      runtime: "workers",
      url: "https://m.test",
      sandbox: "sbx",
      command: ["run"],
      bundleStorageKey: "k",
      sha256: "abc",
      headers: { a: "b" },
      oauth: { clientId: "c" },
      allowedTools: [],
      disabled: false,
      deletedAt: UPDATED_ISO,
    });
    answer("account/mcp:getById", null);
    expect(await convexStorage.mcp.getById(ACCOUNT, "none")).toBeNull();
  });

  test("a policy row and a hook row map to records", async (): Promise<void> => {
    const policy = {
      _id: "pol_1",
      accountId: ACCOUNT,
      name: "p",
      document: { version: 1 },
      status: "active",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("agent/policies:getById", policy);
    expect(await convexStorage.agentPolicies.getById(ACCOUNT, "pol_1")).toEqual(
      {
        accountId: ACCOUNT,
        policyId: "pol_1",
        name: "p",
        document: { version: 1 },
        status: "active",
        createdAt: CREATED_ISO,
        updatedAt: UPDATED_ISO,
      },
    );
    answer("agent/policies:getById", { ...policy, description: "d" });
    expect(
      (await convexStorage.agentPolicies.getById(ACCOUNT, "pol_1"))
        ?.description,
    ).toBe("d");
    answer("agent/policies:getById", null);
    expect(await convexStorage.agentPolicies.getById(ACCOUNT, "x")).toBeNull();

    const hook = {
      _id: "hook_1",
      accountId: ACCOUNT,
      name: "h",
      events: ["beforeTool"],
      bundleStorageKey: "b",
      sha256: "s",
      status: "active",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    answer("account/hooks:getById", hook);
    expect(await convexStorage.accountHooks.getById(ACCOUNT, "hook_1")).toEqual(
      {
        accountId: ACCOUNT,
        hookId: "hook_1",
        name: "h",
        events: ["beforeTool"],
        bundleStorageKey: "b",
        sha256: "s",
        status: "active",
        createdAt: CREATED_ISO,
        updatedAt: UPDATED_ISO,
      },
    );
    answer("account/hooks:getById", {
      ...hook,
      description: "",
      deletedAt: UPDATED,
    });
    expect(
      await convexStorage.accountHooks.getById(ACCOUNT, "hook_1"),
    ).toMatchObject({ description: "", deletedAt: UPDATED_ISO });
    answer("account/hooks:getById", null);
    expect(await convexStorage.accountHooks.getById(ACCOUNT, "x")).toBeNull();
  });
});

describe("removeAllForAccount", (): void => {
  test("removes rows in groups of twenty and reports the count", async (): Promise<void> => {
    const rows = Array.from({ length: 45 }, (_, index) => ({
      _id: `hook_${index}`,
    }));
    answer("account/hooks:list", rows);
    let running = 0;
    let peak = 0;
    const removed: string[] = [];
    answers.set("account/hooks:remove", async (args): Promise<null> => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      removed.push(String(args.hookId));
      running -= 1;

      return null;
    });
    expect(await convexStorage.accountHooks.removeAllForAccount(ACCOUNT)).toBe(
      45,
    );
    expect(removed).toHaveLength(45);
    expect(peak).toBe(20);
  });

  test("an empty list removes nothing and a failure stops the later groups", async (): Promise<void> => {
    answer("account/mcp:list", []);
    expect(await convexStorage.mcp.removeAllForAccount(ACCOUNT)).toBe(0);
    answer(
      "account/mcp:list",
      Array.from({ length: 25 }, (_, index) => ({ _id: `m_${index}` })),
    );
    let attempted = 0;
    answers.set("account/mcp:remove", (): never => {
      attempted += 1;
      throw new Error("remove failed");
    });
    await expect(
      convexStorage.mcp.removeAllForAccount(ACCOUNT),
    ).rejects.toThrow("remove failed");
    expect(attempted).toBe(20);
  });
});
