/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  accountCipher,
  accountCipherForWrite,
  listWrappedKeys,
  mintKey,
  requireAccountIdForProject,
} from "../model/accountKeys";
import { clientErrorData } from "../model/clientError";
import { AccountCipher, blobKeyId, kekIdOf } from "../model/envelope";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const SECRET = "test-config-secret";

type T = TestConvex<typeof schema>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** An org with its account, project and stage, the scope every encrypted row hangs off. */
async function seedAccount(
  tt: T,
  slug: string,
): Promise<{
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: slug,
      slug: slug,
      ownerAuthId: `auth_${slug}`,
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: slug,
      secretHash: `hash_${slug}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: `auth_${slug}`,
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: `auth_${slug}`,
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return { accountId: accountId, projectId: projectId, stageId: stageId };
  });
}

/** One agent row, one account env var and one stage env var, all under the account's current key. */
async function seedEncryptedRows(
  tt: T,
  scope: Awaited<ReturnType<typeof seedAccount>>,
): Promise<{ agentId: Id<"agents">; variableId: Id<"environmentVariables"> }> {
  return await tt.run(async (ctx) => {
    const cipher = await accountCipherForWrite(ctx, scope.accountId);
    const now = Date.now();
    const config = await cipher.encrypt("agents:encryptedConfig", {
      model: { provider: "deepseek" },
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: scope.accountId,
      name: "planner",
      encryptedConfig: config.ciphertext,
      encryptionIv: config.iv,
      encryptionTag: config.tag,
      createdAt: now,
      updatedAt: now,
    });
    const accountVar = await cipher.encrypt("accountEnvVars:ciphertext", {
      value: "acct-value",
    });
    await ctx.db.insert("accountEnvVars", {
      accountId: scope.accountId,
      name: "TOKEN",
      ...accountVar,
      updatedAt: now,
    });
    const stageVar = await cipher.encrypt("environmentVariables:ciphertext", {
      value: "stage-value",
    });
    const variableId = await ctx.db.insert("environmentVariables", {
      projectId: scope.projectId,
      stageId: scope.stageId,
      name: "API_KEY",
      ...stageVar,
      valueDigest: await cipher.digest("stage-value"),
      updatedAt: now,
    });

    return { agentId: agentId, variableId: variableId };
  });
}

test("the first write mints one key per account and later writes reuse it", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  const tt = convexTest(schema, modules);
  const scope = await seedAccount(tt, "beeblast");

  const keyIds = await tt.run(async (ctx) => [
    (await accountCipherForWrite(ctx, scope.accountId)).keyId,
    (await accountCipherForWrite(ctx, scope.accountId)).keyId,
  ]);
  expect(keyIds[0]).toBe(keyIds[1]);
  const keys = await tt.run((ctx) => listWrappedKeys(ctx, scope.accountId));
  expect(keys).toHaveLength(1);
  expect(keys[0]!.kekId).toBe(await kekIdOf(SECRET));

  // A read-only keyring never mints; the account simply has nothing to encrypt with.
  const other = await seedAccount(tt, "other");
  const readOnlyKeyId = await tt.run(
    async (ctx) => (await accountCipher(ctx, other.accountId)).keyId,
  );
  expect(readOnlyKeyId).toBeNull();
  expect(await tt.run((ctx) => listWrappedKeys(ctx, other.accountId))).toEqual(
    [],
  );
});

test("rotateAccountKey rewrites every blob of the account and retires the old key", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const scope = await seedAccount(tt, "beeblast");
  const rows = await seedEncryptedRows(tt, scope);
  const bystander = await seedAccount(tt, "bystander");
  const bystanderRows = await seedEncryptedRows(tt, bystander);
  const before = await tt.run(async (ctx) => ({
    oldKeyId: (await listWrappedKeys(ctx, scope.accountId))[0]!.keyId,
    bystanderBlob: (await ctx.db.get(bystanderRows.agentId))!.encryptedConfig,
  }));

  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
  });
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  const after = await tt.run(async (ctx) => {
    const keys = await listWrappedKeys(ctx, scope.accountId);
    const cipher = await accountCipher(ctx, scope.accountId);
    const agent = (await ctx.db.get(rows.agentId))!;
    const variable = (await ctx.db.get(rows.variableId))!;
    const accountVar = (await ctx.db
      .query("accountEnvVars")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", scope.accountId),
      )
      .unique())!;

    return {
      keys: keys,
      currentKeyId: cipher.keyId,
      agentKeyId: blobKeyId({ ciphertext: agent.encryptedConfig! }),
      agentConfig: await cipher.decrypt("agents:encryptedConfig", {
        ciphertext: agent.encryptedConfig!,
        iv: agent.encryptionIv!,
        tag: agent.encryptionTag!,
      }),
      variableKeyId: blobKeyId(variable),
      variableValue: await cipher.decrypt(
        "environmentVariables:ciphertext",
        variable,
      ),
      variableDigest: variable.valueDigest,
      expectedDigest: await cipher.digest("stage-value"),
      accountVarKeyId: blobKeyId(accountVar),
      accountVarValue: await cipher.decrypt(
        "accountEnvVars:ciphertext",
        accountVar,
      ),
      bystanderBlob: (await ctx.db.get(bystanderRows.agentId))!.encryptedConfig,
    };
  });

  expect(after.keys).toHaveLength(2);
  const [old, current] = after.keys;
  expect(old!.keyId).toBe(before.oldKeyId);
  expect(old!.retiredAt).toBeDefined();
  expect(current!.retiredAt).toBeUndefined();
  expect(after.currentKeyId).toBe(current!.keyId);
  expect(after.agentKeyId).toBe(current!.keyId);
  expect(after.agentConfig).toEqual({ model: { provider: "deepseek" } });
  expect(after.variableKeyId).toBe(current!.keyId);
  expect(after.variableValue).toEqual({ value: "stage-value" });
  expect(after.variableDigest).toBe(after.expectedDigest);
  expect(after.accountVarKeyId).toBe(current!.keyId);
  expect(after.accountVarValue).toEqual({ value: "acct-value" });
  // Another tenant's rows are not touched.
  expect(after.bystanderBlob).toBe(before.bystanderBlob);
});

test("running rotateAccountKey again joins the rotation under way instead of minting another key", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const scope = await seedAccount(tt, "beeblast");
  const rows = await seedEncryptedRows(tt, scope);

  // The first call always answers `isDone: false`, which invites a second.
  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
  });
  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
  });
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  const after = await tt.run(async (ctx) => {
    const agent = (await ctx.db.get(rows.agentId))!;

    return {
      keys: await listWrappedKeys(ctx, scope.accountId),
      config: await (
        await accountCipher(ctx, scope.accountId)
      ).decrypt("agents:encryptedConfig", {
        ciphertext: agent.encryptedConfig!,
        iv: agent.encryptionIv!,
        tag: agent.encryptionTag!,
      }),
    };
  });
  expect(after.keys).toHaveLength(2);
  expect(after.keys.filter((key) => key.retiredAt === undefined)).toHaveLength(
    1,
  );
  expect(after.config).toEqual({ model: { provider: "deepseek" } });
});

test("a walk that finishes after a newer rotation began leaves the retiring to that rotation", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const scope = await seedAccount(tt, "beeblast");
  const rows = await seedEncryptedRows(tt, scope);
  const agentConfig = async (): Promise<Record<string, unknown> | null> =>
    await tt.run(async (ctx) => {
      const agent = (await ctx.db.get(rows.agentId))!;

      return await (
        await accountCipher(ctx, scope.accountId)
      ).decrypt("agents:encryptedConfig", {
        ciphertext: agent.encryptedConfig!,
        iv: agent.encryptionIv!,
        tag: agent.encryptionTag!,
      });
    });

  // The first rotation moves the agent row under its key, then a later one
  // begins before the first walk has finished.
  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
  });
  const firstTarget = await tt.run(async (ctx) => {
    const keyId = (await accountCipher(ctx, scope.accountId)).keyId!;
    await mintKey(ctx, scope.accountId);

    return keyId;
  });
  // The first walk reaches its last table: it must not retire its own key,
  // which the later rotation has not finished replacing.
  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
    table: "connections",
    cursor: null,
    target: firstTarget,
  });
  expect(await agentConfig()).toEqual({ model: { provider: "deepseek" } });

  // The later rotation's own walk finishes the job and retires both.
  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
  });
  await tt.finishAllScheduledFunctions(vi.runAllTimers);
  const keys = await tt.run((ctx) => listWrappedKeys(ctx, scope.accountId));
  expect(keys).toHaveLength(3);
  expect(keys.filter((key) => key.retiredAt === undefined)).toHaveLength(1);
  expect(await agentConfig()).toEqual({ model: { provider: "deepseek" } });
});

test("a config sealed before a rotation is refused instead of stored under the retired key", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const scope = await seedAccount(tt, "beeblast");
  const rows = await seedEncryptedRows(tt, scope);
  // An HTTP action fetches its keyring, then a rotation runs to completion.
  const stale = new AccountCipher(
    scope.accountId,
    [SECRET],
    await tt.mutation(internal.account.keys.ensure, {
      accountId: scope.accountId,
    }),
  );
  await tt.mutation(internal.account.keys.rotateAccountKey, {
    accountId: scope.accountId,
  });
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  const blob = await stale.encrypt("agents:encryptedConfig", { stale: true });
  const refused = await tt
    .mutation(internal.agent.agents.update, {
      accountId: scope.accountId,
      agentId: rows.agentId,
      encryptedConfig: blob.ciphertext,
      encryptionIv: blob.iv,
      encryptionTag: blob.tag,
    })
    .then(
      (): null => null,
      (error: unknown) => clientErrorData(error),
    );
  expect(refused?.code).toBe("conflict");

  const config = await tt.run(async (ctx) => {
    const agent = (await ctx.db.get(rows.agentId))!;

    return await (
      await accountCipher(ctx, scope.accountId)
    ).decrypt("agents:encryptedConfig", {
      ciphertext: agent.encryptedConfig!,
      iv: agent.encryptionIv!,
      tag: agent.encryptionTag!,
    });
  });
  expect(config).toEqual({ model: { provider: "deepseek" } });
});

test("a project whose account is not provisioned yet answers a retryable error", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  const tt = convexTest(schema, modules);

  const refused = await tt.run(async (ctx) => {
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

    return await requireAccountIdForProject(ctx, projectId).then(
      (): null => null,
      (error: unknown) => clientErrorData(error),
    );
  });
  expect(refused).toEqual({
    code: "conflict",
    message: "Account is still being provisioned; retry in a moment",
  });
});

test("rewrapAllKeys moves every key under the first secret so the old one can be dropped", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "old-secret");
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const scope = await seedAccount(tt, "beeblast");
  const rows = await seedEncryptedRows(tt, scope);

  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "new-secret,old-secret");
  await tt.mutation(internal.account.keys.rewrapAllKeys, {});
  await tt.finishAllScheduledFunctions(vi.runAllTimers);
  const keys = await tt.run((ctx) => listWrappedKeys(ctx, scope.accountId));
  expect(keys).toHaveLength(1);
  expect(keys[0]!.kekId).toBe(await kekIdOf("new-secret"));

  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "new-secret");
  const config = await tt.run(async (ctx) => {
    const agent = (await ctx.db.get(rows.agentId))!;

    return await (
      await accountCipher(ctx, scope.accountId)
    ).decrypt("agents:encryptedConfig", {
      ciphertext: agent.encryptedConfig!,
      iv: agent.encryptionIv!,
      tag: agent.encryptionTag!,
    });
  });
  expect(config).toEqual({ model: { provider: "deepseek" } });
});
