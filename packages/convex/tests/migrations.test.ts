/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { accountCipher, listWrappedKeys } from "../model/accountKeys";
import { blobKeyId } from "../model/envelope";
import schema from "../schema";
import { encryptLegacyBlob } from "./legacyBlob.helper";

const modules = import.meta.glob("../**/*.ts");
const SECRET = "test-config-secret";
const AGENT_CONFIG = { model: { provider: "deepseek", modelId: "v4" } };
const SOURCE_CONFIG = { model: { provider: "${PROVIDER}" } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("migrateToEnvelope moves every legacy blob under its account key and is idempotent", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const seeded = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    const resolved = await encryptLegacyBlob(AGENT_CONFIG, SECRET);
    const source = await encryptLegacyBlob(SOURCE_CONFIG, SECRET);
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "planner",
      encryptedConfig: resolved.ciphertext,
      encryptionIv: resolved.iv,
      encryptionTag: resolved.tag,
      encryptedSourceConfig: source.ciphertext,
      sourceEncryptionIv: source.iv,
      sourceEncryptionTag: source.tag,
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: "auth_owner",
      name: "planner",
      agentId: agentId,
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });
    const runtime = await encryptLegacyBlob({ DEEPSEEK_API_KEY: "sk" }, SECRET);
    const runtimeId = await ctx.db.insert("agentRuntimeSecrets", {
      agentConfigId: configId,
      ...runtime,
      updatedAt: now,
    });
    const variable = await encryptLegacyBlob({ value: "stage-value" }, SECRET);
    const variableId = await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: "API_KEY",
      ...variable,
      valueDigest: "legacy-sha256",
      updatedAt: now,
    });

    return {
      accountId: accountId,
      agentId: agentId,
      runtimeId: runtimeId,
      variableId: variableId,
    };
  });

  await tt.mutation(internal.migrations.migrateToEnvelope, {});
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  const snapshot = async (): Promise<Record<string, unknown>> =>
    await tt.run(async (ctx) => {
      const cipher = await accountCipher(ctx, seeded.accountId);
      const agent = (await ctx.db.get(seeded.agentId))!;
      const runtime = (await ctx.db.get(seeded.runtimeId))!;
      const variable = (await ctx.db.get(seeded.variableId))!;
      const resolved = {
        ciphertext: agent.encryptedConfig!,
        iv: agent.encryptionIv!,
        tag: agent.encryptionTag!,
      };
      const source = {
        ciphertext: agent.encryptedSourceConfig!,
        iv: agent.sourceEncryptionIv!,
        tag: agent.sourceEncryptionTag!,
      };

      return {
        keyId: cipher.keyId,
        keyIds: [resolved, source, runtime, variable].map(blobKeyId),
        ciphertexts: [resolved, source, runtime, variable].map(
          (blob) => blob.ciphertext,
        ),
        resolved: await cipher.decrypt("agents:encryptedConfig", resolved),
        source: await cipher.decrypt("agents:encryptedSourceConfig", source),
        runtime: await cipher.decrypt(
          "agentRuntimeSecrets:ciphertext",
          runtime,
        ),
        variable: await cipher.decrypt(
          "environmentVariables:ciphertext",
          variable,
        ),
        digest: variable.valueDigest,
        expectedDigest: await cipher.digest("stage-value"),
      };
    });

  const first = await snapshot();
  expect(first.keyId).toEqual(expect.any(String));
  expect(first.keyIds).toEqual(Array(4).fill(first.keyId));
  expect(first.resolved).toEqual(AGENT_CONFIG);
  expect(first.source).toEqual(SOURCE_CONFIG);
  expect(first.runtime).toEqual({ DEEPSEEK_API_KEY: "sk" });
  expect(first.variable).toEqual({ value: "stage-value" });
  expect(first.digest).toBe(first.expectedDigest);
  expect(
    await tt.run((ctx) => listWrappedKeys(ctx, seeded.accountId)),
  ).toHaveLength(1);

  // A second run finds nothing to rewrite: the ciphertexts stay byte-identical.
  await tt.mutation(internal.migrations.migrateToEnvelope, {});
  await tt.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await snapshot()).ciphertexts).toEqual(first.ciphertexts);
});

test("migrateToEnvelope opens rows written under a secret that holds a comma", async () => {
  const raw = "left, right ";
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", raw);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const seeded = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "comma",
      slug: "comma",
      ownerAuthId: "auth_comma",
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "comma",
      secretHash: "hash-comma",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const legacy = await encryptLegacyBlob(AGENT_CONFIG, raw);
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "planner",
      encryptedConfig: legacy.ciphertext,
      encryptionIv: legacy.iv,
      encryptionTag: legacy.tag,
      createdAt: now,
      updatedAt: now,
    });

    return { accountId: accountId, agentId: agentId };
  });

  await tt.mutation(internal.migrations.migrateToEnvelope, {});
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  const config = await tt.run(async (ctx) => {
    const agent = (await ctx.db.get(seeded.agentId))!;
    expect(blobKeyId({ ciphertext: agent.encryptedConfig! })).toEqual(
      expect.any(String),
    );

    return await (
      await accountCipher(ctx, seeded.accountId)
    ).decrypt("agents:encryptedConfig", {
      ciphertext: agent.encryptedConfig!,
      iv: agent.encryptionIv!,
      tag: agent.encryptionTag!,
    });
  });
  expect(config).toEqual(AGENT_CONFIG);
});

test("migrateToEnvelope counts rows it cannot move because their project has no account", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const variableId = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "fresh",
      slug: "fresh",
      ownerAuthId: "auth_fresh",
      plan: "free",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_fresh",
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_fresh",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    const variable = await encryptLegacyBlob({ value: "v" }, SECRET);

    return await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: "API_KEY",
      ...variable,
      valueDigest: "legacy-sha256",
      updatedAt: now,
    });
  });

  const result = await tt.mutation(internal.migrations.migrateToEnvelope, {
    table: "environmentVariables",
    cursor: null,
    skipped: 2,
  });
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  expect(result.patched).toBe(0);
  expect(result.skipped).toBe(3);
  const after = await tt.run((ctx) => ctx.db.get(variableId));
  expect(blobKeyId(after!)).toBeNull();
});

test("migrateToEnvelope leaves an account with no legacy rows alone", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const accountId: Id<"accounts"> = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "empty",
      slug: "empty",
      ownerAuthId: "auth_empty",
      plan: "free",
      createdAt: now,
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "empty",
      secretHash: "hash-empty",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });

  const result = await tt.mutation(internal.migrations.migrateToEnvelope, {});
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  expect(result.patched).toBe(0);
  expect(await tt.run((ctx) => listWrappedKeys(ctx, accountId))).toEqual([]);
});

test("workspaceIsolationLevels stores a boolean isolation as the conversation level", async () => {
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const configs = [
    { storage: { provider: "s3" }, isolation: true },
    { storage: { provider: "s3" }, isolation: "agent" },
    { storage: { provider: "s3", bucket: "own", prefix: "agents/" } },
  ];
  const ids = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return await Promise.all(
      configs.map((config, index) =>
        ctx.db.insert("workspaceConfigs", {
          accountId: accountId,
          name: `workspace-${index}`,
          config: config,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );
  });

  const result = await tt.mutation(
    internal.migrations.workspaceIsolationLevels,
    {},
  );
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  expect(result).toEqual({ patched: 1, isDone: true });
  const stored = await tt.run(async (ctx) =>
    Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.config)),
  );
  expect(stored).toEqual([
    { storage: { provider: "s3" }, isolation: "conversation" },
    { storage: { provider: "s3" }, isolation: "agent" },
    { storage: { provider: "s3", bucket: "own", prefix: "agents/" } },
  ]);
});

test("pruneStaleRows clears plaintext conversation targets and deletes orphaned secrets and dead login codes", async () => {
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const target = { channelName: "slack", source: { channel: "C1" } };
  const ids = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    const coordinator = async (
      key: string,
      channelTarget: NonNullable<
        Doc<"runtimeConversationCoordinators">["channelTarget"]
      >,
    ): Promise<Id<"runtimeConversationCoordinators">> =>
      await ctx.db.insert("runtimeConversationCoordinators", {
        accountId: accountId,
        agentId: "agent",
        conversationKey: key,
        channelTarget: channelTarget,
        nextSequence: 1,
        ownerGeneration: 1,
        queuedCount: 0,
        queuedBytes: 0,
        updatedAt: now,
      });
    const config = async (name: string): Promise<Id<"agentConfigs">> =>
      await ctx.db.insert("agentConfigs", {
        authId: "auth_owner",
        name: name,
        projectId: projectId,
        stageId: stageId,
        updatedAt: now,
      });
    const secret = async (
      agentConfigId: Id<"agentConfigs">,
    ): Promise<Id<"agentRuntimeSecrets">> =>
      await ctx.db.insert("agentRuntimeSecrets", {
        agentConfigId: agentConfigId,
        ciphertext: "ciphertext",
        iv: "iv",
        tag: "tag",
        updatedAt: now,
      });
    const code = async (
      hash: string,
      expiresAt: number,
      usedAt?: number,
    ): Promise<Id<"cliAuthCodes">> =>
      await ctx.db.insert("cliAuthCodes", {
        codeHash: hash,
        authId: "auth_owner",
        orgId: orgId,
        accountId: accountId,
        expiresAt: expiresAt,
        usedAt: usedAt,
        createdAt: now,
      });
    const deletedConfigId = await config("deleted");
    await ctx.db.delete(deletedConfigId);

    return {
      legacy: await coordinator("legacy", {
        ...target,
        agentConfig: { provider: { openai: { apiKey: "sk-plain" } } },
      }),
      clean: await coordinator("clean", {
        ...target,
        channelRecordId: "record",
      }),
      orphanSecret: await secret(deletedConfigId),
      liveSecret: await secret(await config("live")),
      expiredCode: await code("expired", now - 1),
      usedCode: await code("used", now + 60_000, now),
      liveCode: await code("live", now + 60_000),
    };
  });

  const first = await tt.mutation(internal.migrations.pruneStaleRows, {});
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  // The first batch only reached the coordinators; the rest ran rescheduled.
  expect(first).toEqual({ cleared: 1, deleted: 0, isDone: false });
  const after = await tt.run(async (ctx) => ({
    legacy: await ctx.db.get(ids.legacy),
    clean: (await ctx.db.get(ids.clean))?.channelTarget,
    orphanSecret: await ctx.db.get(ids.orphanSecret),
    liveSecret: (await ctx.db.get(ids.liveSecret))?._id,
    expiredCode: await ctx.db.get(ids.expiredCode),
    usedCode: await ctx.db.get(ids.usedCode),
    liveCode: (await ctx.db.get(ids.liveCode))?._id,
  }));
  expect(after.legacy).toMatchObject({ conversationKey: "legacy" });
  expect(after.legacy?.channelTarget).toBeUndefined();
  expect(after).toMatchObject({
    clean: { ...target, channelRecordId: "record" },
    orphanSecret: null,
    liveSecret: ids.liveSecret,
    expiredCode: null,
    usedCode: null,
    liveCode: ids.liveCode,
  });

  // A second walk finds nothing left to prune.
  expect(
    await tt.mutation(internal.migrations.pruneStaleRows, {
      table: "cliAuthCodes",
      cursor: null,
    }),
  ).toEqual({ cleared: 0, deleted: 0, isDone: true });
});

test("pruneStaleRows reports the walk's totals on its last batch", async () => {
  const tt = convexTest(schema, modules);

  const result = await tt.mutation(internal.migrations.pruneStaleRows, {
    table: "cliAuthCodes",
    cursor: null,
    cleared: 2,
    deleted: 5,
  });

  expect(result).toEqual({ cleared: 2, deleted: 5, isDone: true });
});
