/// <reference types="vite/client" />
/**
 * The stage's user-token signing secret: an admin mints it from the
 * dashboard, sees it once, and core receives it sealed with the runtime key's
 * deployment. The per-agent requirement is a dashboard switch on the agent
 * row that config syncs never touch.
 */

import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { accountCipher } from "../model/accountKeys";
import { sha256Hex } from "../model/accountSecrets";
import {
  openUserToken,
  sealUserToken,
  USER_TOKEN_SECRET_PREFIX,
} from "../model/userToken";
import schema from "../schema";

const AUTH_ID = "user_token_secret_owner";
const modules = import.meta.glob("../**/*.ts");

type T = TestConvex<typeof schema>;

afterEach((): void => {
  vi.unstubAllEnvs();
});

test("an admin mints the signing secret once and core opens tokens with it", async (): Promise<void> => {
  const { t, caller, accountId, projectId, stageId } = await setup();
  const scope = { projectId: projectId, stageId: stageId };

  await expect(
    caller.mutation(api.agent.deployments.rotateUserTokenSecret, scope),
  ).rejects.toThrow("Generate the stage's runtime key first.");
  const deployment = await caller.mutation(
    api.agent.deployments.ensureForStage,
    scope,
  );
  expect(
    await caller.query(api.agent.deployments.userTokenSecretForStage, scope),
  ).toBeNull();

  const first = await caller.mutation(
    api.agent.deployments.rotateUserTokenSecret,
    scope,
  );
  const second = await caller.mutation(
    api.agent.deployments.rotateUserTokenSecret,
    scope,
  );

  expect(second.secret.startsWith(USER_TOKEN_SECRET_PREFIX)).toBe(true);
  expect(second.secret).not.toBe(first.secret);
  expect(
    await caller.query(api.agent.deployments.userTokenSecretForStage, scope),
  ).toMatchObject({ hint: second.hint });

  const resolved = await t.query(internal.agent.deployments.getByApiKeyHash, {
    apiKeyHash: await sha256Hex(deployment.rawApiKey),
  });
  const sealed = resolved?.userTokenSecret;
  expect(sealed).toBeDefined();
  expect(JSON.stringify(sealed)).not.toContain(second.secret);
  const opened = await t.run(async (ctx) =>
    (await accountCipher(ctx, accountId)).decrypt(
      "agentDeployments:userTokenSecretCiphertext",
      sealed!,
    ),
  );
  expect(opened).toEqual({ value: second.secret });

  // Rotation voids every token the earlier secret signed.
  const token = { userId: "alice", expiresAt: Date.now() + 60_000 };
  expect(
    await openUserToken(
      await sealUserToken(token, first.secret),
      second.secret,
    ),
  ).toBeNull();
  expect(
    await openUserToken(
      await sealUserToken(token, second.secret),
      second.secret,
    ),
  ).toEqual(token);
});

test("an admin turns an agent's user-token requirement on and off", async (): Promise<void> => {
  const { t, caller, accountId, projectId, stageId } = await setup();
  const { configId, agentId } = await t.run(async (ctx) => {
    const now = Date.now();
    // A row from before the requirement shipped: no field at all.
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "legacy",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: AUTH_ID,
      projectId: projectId,
      stageId: stageId,
      name: "legacy",
      agentId: agentId,
      updatedAt: now,
    });

    return { configId: configId, agentId: agentId };
  });
  const config = { configId: configId };

  expect(
    await caller.query(api.agent.config.userTokenRequirement, config),
  ).toBe(false);
  await caller.mutation(api.agent.config.setRequireUserToken, {
    ...config,
    required: true,
  });
  expect(
    await caller.query(api.agent.config.userTokenRequirement, config),
  ).toBe(true);
  await caller.mutation(api.agent.config.setRequireUserToken, {
    ...config,
    required: false,
  });

  expect(
    (await t.run(async (ctx) => ctx.db.get(agentId)))?.requireUserToken,
  ).toBe(false);
});

async function setup(): Promise<{
  t: T;
  caller: ReturnType<T["withIdentity"]>;
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}> {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  const t = convexTest(schema, modules);
  workosTest.register(t);
  await seedAuthUser(t);
  const caller = t.withIdentity({ subject: AUTH_ID });
  const orgId = await caller.mutation(api.org.orgs.create, {
    name: "Token fixture",
  });
  const account = await t.mutation(internal.account.accounts.create, {
    orgId: orgId,
    username: "token-fixture",
    secretHash: await sha256Hex("bask_token_fixture_key"),
  });
  const { projectId, stageId } = await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "fixture",
      slug: "fixture",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });

    return { projectId: projectId, stageId: stageId };
  });

  return {
    t: t,
    caller: caller,
    accountId: account._id,
    projectId: projectId,
    stageId: stageId,
  };
}

/** Seed AuthKit's verified user projection without replacing its getAuthUser implementation. */
async function seedAuthUser(t: T): Promise<void> {
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    apiKey: "sk_test_fixture",
    event: {
      id: "evt_user_token_signup",
      event: "user.created",
      createdAt: now,
      data: {
        id: AUTH_ID,
        email: "token-owner@example.invalid",
        emailVerified: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await t.run(async (ctx): Promise<void> => {
    await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "token-owner@example.invalid",
      name: "Token owner",
      plan: "free",
    });
  });
}
