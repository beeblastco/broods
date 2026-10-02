/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  type NestedAgentConfig,
} from "../model/agentConfigCodec";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const SECRET = "test-config-secret";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("renameSessionCompaction moves every stored config off session.compaction", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  vi.useFakeTimers();
  const tt = convexTest(schema, modules);
  const off: NestedAgentConfig = {
    model: { id: "gpt-5" },
    session: { pruning: { enabled: true }, compaction: { enabled: false } },
  };
  const on: NestedAgentConfig = {
    session: { compaction: { enabled: true, maxContextLength: 80_000 } },
  };
  const { agentId, configId } = await tt.run(async (ctx) => {
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
    const resolved = await encryptAgentConfigBlob(off, SECRET);
    const source = await encryptAgentConfigBlob(on, SECRET);
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
      extraConfig: off,
      updatedAt: now,
    });

    return { agentId: agentId, configId: configId };
  });

  await tt.mutation(internal.migrations.renameSessionCompaction, {
    table: "agents",
  });
  await tt.finishAllScheduledFunctions(vi.runAllTimers);

  const { agent, config } = await tt.run(async (ctx) => ({
    agent: await ctx.db.get(agentId),
    config: await ctx.db.get(configId),
  }));
  expect(
    await decryptAgentConfigBlob(
      {
        ciphertext: agent!.encryptedConfig!,
        iv: agent!.encryptionIv!,
        tag: agent!.encryptionTag!,
      },
      SECRET,
    ),
  ).toEqual({
    model: { id: "gpt-5" },
    session: { pruning: { enabled: true }, autoCompaction: { enabled: false } },
  });
  expect(
    await decryptAgentConfigBlob(
      {
        ciphertext: agent!.encryptedSourceConfig!,
        iv: agent!.sourceEncryptionIv!,
        tag: agent!.sourceEncryptionTag!,
      },
      SECRET,
    ),
  ).toEqual({ session: {} });
  expect(config!.extraConfig).toEqual({
    model: { id: "gpt-5" },
    session: { pruning: { enabled: true }, autoCompaction: { enabled: false } },
  });
});
