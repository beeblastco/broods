/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: "auth_owner" }) },
}));

const modules = import.meta.glob("../**/*.ts");

const SECRET_HASH = "hash-audit-coverage";

const auditTest = () => convexTest(schema, modules);

type T = ReturnType<typeof auditTest>;

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

test("key rotation, member, role and policy changes land in the audit ledger", async () => {
  const t = auditTest();
  const { orgId, memberMembership } = await seed(t);

  await t
    .withIdentity({ subject: "auth_owner" })
    .action(api.org.lifecycle.rotateSecret, { orgId: orgId });
  await t.mutation(api.org.members.updateRole, {
    membershipId: memberMembership,
    role: "admin",
  });
  const policyId = await t.mutation(api.access.createPolicy, {
    name: "deny shell",
    mode: "enforce",
  });
  await t.mutation(api.access.createRole, {
    name: "Support",
    policyIds: [policyId],
  });

  expect(await ledger(t)).toEqual([
    "account secret-rotated",
    "member role-changed",
    "policy created",
    "role created",
  ]);
});

test("the project policy panel's create, update and remove land in the ledger by name", async () => {
  const t = auditTest();
  const { projectId, stageId } = await seed(t);
  const document = {
    version: 1,
    mode: "enforce",
    rules: [
      {
        id: "r1",
        effect: "deny",
        actions: ["tool.call"],
        resources: { mcpIds: ["secret-mcp-id"] },
      },
    ],
  };

  const policyId = await t.mutation(api.agent.policies.create, {
    projectId: projectId,
    stageId: stageId,
    name: "deny shell",
    document: document,
  });
  await t.mutation(api.agent.policies.update, {
    policyId: policyId,
    name: "deny tools",
  });
  await t.mutation(api.agent.policies.remove, { policyId: policyId });

  const rows = await t.run(async (ctx) =>
    ctx.db.query("auditEvents").collect(),
  );
  expect(
    rows.map(
      (row) => `${row.resource.kind} ${row.action} ${row.resource.name}`,
    ),
  ).toEqual([
    "policy created deny shell",
    "policy updated deny tools",
    "policy deleted deny tools",
  ]);
  expect(rows.every((row) => row.stageId === stageId)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("secret-mcp-id");
});

test("a CLI env write is audited by name, never by value", async () => {
  const t = auditTest();
  await seed(t);
  const target = {
    secretHash: SECRET_HASH,
    project: "demo-app",
    stage: "development",
    name: "API_TOKEN",
    actorKind: "cli" as const,
    actorId: "auth_owner",
  };

  await t.mutation(internal.cli.sync.setEnvBySecretHash, {
    ...target,
    value: "sk-live-secret",
  });
  await t.mutation(internal.cli.sync.removeEnvBySecretHash, target);

  const rows = await t.run(async (ctx) =>
    ctx.db.query("auditEvents").collect(),
  );
  expect(
    rows.map((row) => `${row.actor.kind} ${row.resource.kind} ${row.action}`),
  ).toEqual([
    "cli environmentVariable created",
    "cli environmentVariable deleted",
  ]);
  expect(JSON.stringify(rows)).not.toContain("sk-live-secret");
});

async function ledger(t: T): Promise<string[]> {
  const rows = await t.run(async (ctx) =>
    ctx.db.query("auditEvents").collect(),
  );

  return rows.map((row) => `${row.resource.kind} ${row.action}`);
}

async function seed(t: T): Promise<{
  orgId: Id<"orgs">;
  memberMembership: Id<"orgMembers">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: SECRET_HASH,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    let memberMembership: Id<"orgMembers"> | null = null;
    for (const [authId, role] of [
      ["auth_owner", "owner"],
      ["auth_member", "member"],
    ] as const) {
      const userId = await ctx.db.insert("users", {
        authId: authId,
        email: `${authId}@example.com`,
        name: authId,
        plan: "free",
      });
      const membershipId = await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: userId,
        role: role,
        createdAt: now,
      });
      if (role === "member") memberMembership = membershipId;
    }
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
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

    return {
      orgId: orgId,
      memberMembership: memberMembership!,
      projectId: projectId,
      stageId: stageId,
    };
  });
}
