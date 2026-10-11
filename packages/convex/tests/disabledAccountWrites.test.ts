/// <reference types="vite/client" />
/**
 * A disabled account is read-only on the direct Convex surface, as it is on
 * the config HTTP surface: no skill writes, upload URLs, workspace storage,
 * MCP calls, crons, connections or access changes. Deleting the org stays open.
 */

import cronsComponent from "@convex-dev/crons/test";
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const AUTH_ID = "user_disabled_account_owner";
const ACCOUNT_KEY = "bask_disabled_account_fixture_key";
const BUCKET = "disabled-account-fixture-bucket";
const NOT_ACTIVE = /Account is not active/;
const modules = import.meta.glob("../**/*.ts");
const storageCalls = vi.hoisted(() => ({
  deletePrefix: vi.fn().mockResolvedValue(0),
  writeObject: vi.fn().mockResolvedValue(undefined),
}));

// Only the external S3 boundary is replaced; auth, key lookup, validation
// and every database write stay real.
vi.mock("../model/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("../model/s3")>();

  return {
    ...original,
    deleteS3Prefix: storageCalls.deletePrefix,
    writeS3Object: storageCalls.writeObject,
  };
});

type T = TestConvex<typeof schema>;

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("a disabled account cannot write skills or mint upload URLs", async (): Promise<void> => {
  const { t, caller, orgId, accountId } = await setup();
  const skill = {
    bearerToken: ACCOUNT_KEY,
    name: "fixture-skill",
    description: "A harmless fixture",
    content: "Fixture instructions.",
  };

  // While active, the same key and caller write.
  expect(
    await caller.mutation(api.workspace.files.generateUploadUrl, {}),
  ).toBeTruthy();
  expect(
    (await caller.action(api.skillsPublic.createFromJson, skill)).path,
  ).toBe(`${accountId}/fixture-skill`);
  expect(storageCalls.writeObject).toHaveBeenCalledTimes(1);
  storageCalls.deletePrefix.mockClear();
  storageCalls.writeObject.mockClear();

  await disable(t, accountId);
  expect(
    (
      await t.fetch("/v1/skills", {
        method: "GET",
        headers: { Authorization: `Bearer ${ACCOUNT_KEY}` },
      })
    ).status,
  ).toBe(401);

  await expect(
    caller.mutation(api.workspace.files.generateUploadUrl, {}),
  ).rejects.toThrow(NOT_ACTIVE);
  expect(
    await t.run(async (ctx) => ctx.db.query("uploadGrants").collect()),
  ).toHaveLength(1);

  await expect(
    caller.action(api.skillsPublic.createFromJson, skill),
  ).rejects.toThrow("Invalid Bearer token");
  await expect(
    caller.action(api.skillsPublic.createFromGithub, {
      bearerToken: ACCOUNT_KEY,
      githubUrl: "https://github.com/example/skills/tree/main/fixture",
    }),
  ).rejects.toThrow("Invalid Bearer token");
  const projectId = await seedProject(t, orgId);
  await expect(
    caller.action(api.skillsPublic.publishSkill, {
      projectId: projectId,
      nodeId: "skill-node",
      bearerToken: ACCOUNT_KEY,
    }),
  ).rejects.toThrow("Invalid Bearer token");

  // Anonymous callers and unknown keys stay refused.
  await expect(
    t.action(api.skillsPublic.createFromJson, skill),
  ).rejects.toThrow("not authenticated");
  await expect(
    caller.action(api.skillsPublic.createFromJson, {
      ...skill,
      bearerToken: "bask_unknown_fixture_key",
    }),
  ).rejects.toThrow("Invalid Bearer token");
  expect(storageCalls.deletePrefix).not.toHaveBeenCalled();
  expect(storageCalls.writeObject).not.toHaveBeenCalled();
});

test("a disabled account cannot reach workspace storage or MCP servers", async (): Promise<void> => {
  const { t, caller, orgId, accountId } = await setup();
  const projectId = await seedProject(t, orgId);
  const { stageId, workspaceId } = await t.run(async (ctx) => {
    const now = Date.now();

    return {
      stageId: await ctx.db.insert("stages", {
        authId: AUTH_ID,
        projectId: projectId,
        name: "Development",
        kind: "development" as const,
        isDefault: true,
        updatedAt: now,
      }),
      workspaceId: await ctx.db.insert("workspaceConfigs", {
        accountId: accountId,
        projectId: projectId,
        name: "fixture-workspace",
        config: { storage: { provider: "s3" } },
        createdAt: now,
        updatedAt: now,
      }),
    };
  });
  await disable(t, accountId);

  const workspace = { projectId: projectId, workspaceId: workspaceId };
  await expect(
    caller.action(api.workspace.filesPublic.upload, {
      ...workspace,
      path: "notes.md",
      contentBase64: "aGk=",
    }),
  ).rejects.toThrow(NOT_ACTIVE);
  await expect(
    caller.action(api.workspace.filesPublic.rename, {
      ...workspace,
      path: "notes.md",
      newPath: "moved.md",
    }),
  ).rejects.toThrow(NOT_ACTIVE);
  await expect(
    caller.action(api.workspace.filesPublic.remove, {
      ...workspace,
      path: "notes.md",
    }),
  ).rejects.toThrow(NOT_ACTIVE);
  await expect(
    caller.action(api.workspace.filesPublic.list, workspace),
  ).rejects.toThrow(NOT_ACTIVE);

  const node = { projectId: projectId, stageId: stageId, nodeId: "mcp-node" };
  await expect(
    caller.action(api.mcp.saveForNode, {
      ...node,
      nodeLabel: "Fixture MCP",
      bundle: "export default {};",
    }),
  ).rejects.toThrow(NOT_ACTIVE);
  await expect(
    caller.action(api.mcp.callTool, { ...node, toolName: "echo" }),
  ).rejects.toThrow(NOT_ACTIVE);
  await expect(caller.action(api.mcp.removeForNode, node)).rejects.toThrow(
    NOT_ACTIVE,
  );
  expect(storageCalls.writeObject).not.toHaveBeenCalled();
});

test("a disabled account cannot change crons, connections or access, and can still delete its org", async (): Promise<void> => {
  const { t, caller, orgId, accountId } = await setup();
  const policyId = await caller.mutation(api.access.createPolicy, {
    name: "fixture-policy",
    mode: "enforce",
  });
  const permissionId = await caller.mutation(api.access.createPermission, {
    name: "fixture:read",
    resource: "fixture",
  });
  const roleId = await caller.mutation(api.access.createRole, {
    name: "fixture-role",
    policyIds: [],
  });
  const agentId = await t.run(async (ctx) =>
    ctx.db.insert("agents", {
      accountId: accountId,
      name: "fixture-agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await disable(t, accountId);

  const refused: Array<() => Promise<unknown>> = [
    () =>
      caller.mutation(api.agent.cronsPublic.create, {
        name: "nightly",
        agentId: agentId,
        input: "run",
        scheduleExpression: "rate(1 day)",
        status: "active",
      }),
    () =>
      caller.mutation(api.agent.cronsPublic.update, {
        cronId: "fixture-cron",
        input: "run again",
      }),
    () =>
      caller.mutation(api.agent.cronsPublic.remove, { cronId: "fixture-cron" }),
    () =>
      caller.mutation(api.account.connectionsPublic.disconnect, {
        type: "chatgpt",
      }),
    () =>
      caller.mutation(api.access.createPermission, {
        name: "fixture:write",
        resource: "fixture",
      }),
    () =>
      caller.mutation(api.access.removePermission, {
        permissionId: permissionId,
      }),
    () =>
      caller.mutation(api.access.createPolicy, {
        name: "another-policy",
        mode: "audit",
      }),
    () =>
      caller.mutation(api.access.updatePolicy, {
        policyId: policyId,
        mode: "audit",
      }),
    () =>
      caller.mutation(api.access.addRule, {
        policyId: policyId,
        permission: "fixture:read",
        scope: {},
      }),
    () =>
      caller.mutation(api.access.removeRule, {
        policyId: policyId,
        ruleId: "fixture-rule",
      }),
    () => caller.mutation(api.access.removePolicy, { policyId: policyId }),
    () =>
      caller.mutation(api.access.createRole, {
        name: "another-role",
        policyIds: [],
      }),
    () =>
      caller.mutation(api.access.updateRole, {
        roleId: roleId,
        name: "renamed",
      }),
    () => caller.mutation(api.access.removeRole, { roleId: roleId }),
  ];
  for (const call of refused) await expect(call()).rejects.toThrow(NOT_ACTIVE);

  // Reads stay open so the dashboard can show the account and its state.
  expect(await caller.query(api.org.orgs.getActiveAccount, {})).toMatchObject({
    accountId: accountId,
    status: "disabled",
  });

  // The owner can still delete the org, which takes the account with it.
  vi.useFakeTimers();
  await caller.mutation(api.org.orgs.remove, { orgId: orgId });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await t.run(async (ctx) => ctx.db.get(accountId))).toBeNull();
});

/** A signed-in owner of an org whose account is active until `disable`. */
async function setup(): Promise<{
  t: T;
  caller: ReturnType<T["withIdentity"]>;
  orgId: Id<"orgs">;
  accountId: Id<"accounts">;
}> {
  vi.stubEnv("SKILLS_BUCKET_NAME", BUCKET);
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  const t = convexTest(schema, modules);
  workosTest.register(t);
  cronsComponent.register(t);
  await seedAuthUser(t);
  const caller = t.withIdentity({ subject: AUTH_ID });
  const orgId = await caller.mutation(api.org.orgs.create, {
    name: "Disabled fixture",
  });
  const account = await t.mutation(internal.account.accounts.create, {
    orgId: orgId,
    username: "disabled-fixture",
    secretHash: await sha256Hex(ACCOUNT_KEY),
  });

  return { t: t, caller: caller, orgId: orgId, accountId: account._id };
}

async function disable(t: T, accountId: Id<"accounts">): Promise<void> {
  await t.run(async (ctx): Promise<void> => {
    await ctx.db.patch(accountId, { status: "disabled" });
  });
}

async function seedProject(t: T, orgId: Id<"orgs">): Promise<Id<"projects">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "fixture",
      slug: "fixture",
      updatedAt: Date.now(),
    }),
  );
}

/** Seed AuthKit's verified user projection without replacing its getAuthUser implementation. */
async function seedAuthUser(t: T): Promise<void> {
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    apiKey: "sk_test_fixture",
    event: {
      id: "evt_disabled_account_signup",
      event: "user.created",
      createdAt: now,
      data: {
        id: AUTH_ID,
        email: "disabled-account@example.invalid",
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
      email: "disabled-account@example.invalid",
      name: "Disabled account owner",
      plan: "free",
    });
  });
}
