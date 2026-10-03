/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
