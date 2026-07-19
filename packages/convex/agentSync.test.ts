/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** Seeds an org owned by `email`, its account, and the owner membership. */
async function seedOrg(
  tt: T,
  opts: {
    orgName: string;
    slug: string;
    username: string;
    email: string;
    onboardedAt?: number;
  },
) {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: opts.orgName,
      slug: opts.slug,
      ownerAuthId: "auth_" + opts.email,
      plan: "free" as const,
      createdAt: now,
      onboardedAt: opts.onboardedAt,
    });

    let user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", opts.email))
      .unique();
    const userId =
      user?._id ??
      (await ctx.db.insert("users", {
        authId: "auth_" + opts.email,
        email: opts.email,
        name: "Owner",
        plan: "free" as const,
      }));

    await ctx.db.insert("orgMembers", {
      orgId,
      userId,
      role: "owner" as const,
      createdAt: now,
    });

    const accountId = await ctx.db.insert("accounts", {
      orgId,
      username: opts.username,
      secretHash: "hash-" + opts.username,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });

    return { orgId, userId, accountId };
  });
}

const createAgent = (tt: T, accountId: Id<"accounts">, name: string) =>
  tt.mutation(internal.agents.create, { accountId, name });

const configFor = (tt: T, agentId: Id<"agents">) =>
  tt.run(async (ctx) =>
    ctx.db
      .query("agentConfigs")
      .withIndex("by_agentId", (q) => q.eq("agentId", agentId))
      .first(),
  );

describe("backSyncCanvasFromAgentRow", () => {
  test("puts an API-created agent under a project named after the account", async () => {
    const tt = t();
    const { orgId, accountId } = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "beeblast-sale-agent-dev",
      email: "owner@example.com",
    });

    const agentId = await createAgent(tt, accountId, "beeblast-agent-cust1");

    const config = await configFor(tt, agentId);
    expect(config).not.toBeNull();

    await tt.run(async (ctx) => {
      const project = await ctx.db.get(config!.projectId);
      // The project is created on demand, so an org that never went
      // through dashboard onboarding still gets one — and it is named
      // for the account rather than a random adjective-noun pair.
      expect(project?.name).toBe("beeblast-sale-agent-dev");
      expect(project?.orgId).toBe(orgId);

      const environment = await ctx.db.get(config!.environmentId);
      expect(environment?.projectId).toBe(config!.projectId);
    });
  });

  test("never places an agent in another org's project owned by the same user", async () => {
    const tt = t();
    // The owner's personal org comes first by authId, so an authId-keyed
    // project lookup would drop the beeblast agent into `personal`.
    const personal = await seedOrg(tt, {
      orgName: "personal",
      slug: "personal",
      username: "personal-account",
      email: "owner@example.com",
    });
    const personalProjectId = await tt.run(
      async (ctx) =>
        await ctx.db.insert("projects", {
          authId: "auth_owner@example.com",
          orgId: personal.orgId,
          name: "agent-hooks",
          slug: "agent-hooks",
          updatedAt: Date.now(),
        }),
    );

    const beeblast = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "beeblast-sale-agent-dev",
      email: "owner@example.com",
    });

    const agentId = await createAgent(
      tt,
      beeblast.accountId,
      "beeblast-agent-cust1",
    );

    const config = await configFor(tt, agentId);
    expect(config!.projectId).not.toBe(personalProjectId);
    await tt.run(async (ctx) => {
      const project = await ctx.db.get(config!.projectId);
      expect(project?.orgId).toBe(beeblast.orgId);
    });
  });

  test("reuses the org's existing project instead of minting one per agent", async () => {
    const tt = t();
    const { orgId, accountId } = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "beeblast-sale-agent-dev",
      email: "owner@example.com",
    });

    const first = await createAgent(tt, accountId, "beeblast-agent-cust1");
    const second = await createAgent(tt, accountId, "beeblast-agent-cust2");

    const a = await configFor(tt, first);
    const b = await configFor(tt, second);
    // The whole app's agents share one project: the selector must not grow
    // an entry per customer.
    expect(a!.projectId).toBe(b!.projectId);

    await tt.run(async (ctx) => {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .collect();
      expect(projects).toHaveLength(1);
    });
  });

  test("no-ops for an account whose org has not been adopted yet", async () => {
    const tt = t();
    const accountId = await tt.run(
      async (ctx) =>
        await ctx.db.insert("accounts", {
          orgId: "external:sale-agent-dev",
          username: "beeblast-sale-agent-dev",
          secretHash: "hash-x",
          status: "active" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );

    const agentId = await createAgent(tt, accountId, "beeblast-agent-cust1");

    // The agent still exists and runs; it just has no project. This is the
    // state the two pre-adoption dev agents were in.
    expect(await configFor(tt, agentId)).toBeNull();
  });

  test("an agent recreated after adoption lands in the project", async () => {
    const tt = t();
    const accountId = await tt.run(
      async (ctx) =>
        await ctx.db.insert("accounts", {
          orgId: "external:sale-agent-dev",
          username: "beeblast-sale-agent-dev",
          secretHash: "hash-x",
          status: "active" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );
    const stranded = await createAgent(tt, accountId, "beeblast-agent-cust1");
    expect(await configFor(tt, stranded)).toBeNull();

    // Adopt the account, then delete and re-create the agent the way the
    // owning app's sync does when it finds its agent gone.
    const { orgId } = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "placeholder",
      email: "owner@example.com",
    });
    await tt.run(async (ctx) => {
      const placeholder = await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
        .unique();
      await ctx.db.delete(placeholder!._id);
      await ctx.db.patch(accountId, { orgId: orgId });
      await ctx.db.delete(stranded);
    });

    const recreated = await createAgent(tt, accountId, "beeblast-agent-cust1");

    const config = await configFor(tt, recreated);
    expect(config).not.toBeNull();
    await tt.run(async (ctx) => {
      const project = await ctx.db.get(config!.projectId);
      expect(project?.orgId).toBe(orgId);
    });
  });
});

describe("syncApiAgentCanvasWiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Account-scoped rows shaped like the account REST API creates them. */
  const seedWiringFixtures = (tt: T, accountId: Id<"accounts">) =>
    tt.run(async (ctx) => {
      const now = Date.now();
      const workspaceId = await ctx.db.insert("workspaceConfigs", {
        accountId: accountId,
        name: "beeblast-ws-cust1",
        config: { storage: { provider: "s3" }, isolation: true },
        createdAt: now,
        updatedAt: now,
      });
      const sandboxId = await ctx.db.insert("sandboxConfigs", {
        accountId: accountId,
        name: "beeblast-sandbox",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("skills", {
        accountId: accountId,
        name: "crm-sync",
        s3Key: "skills/crm-sync.zip",
        createdAt: now,
        updatedAt: now,
      });

      return { workspaceId: workspaceId, sandboxId: sandboxId };
    });

  /** The canvas layout of the environment the config was back-synced into. */
  const layoutFor = (tt: T, config: Doc<"agentConfigs">) =>
    tt.run(async (ctx) =>
      ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_environmentId", (q) =>
          q
            .eq("projectId", config.projectId)
            .eq("environmentId", config.environmentId),
        )
        .unique(),
    );

  test("mirrors sandbox/workspace/skill wiring as locked api nodes and edges", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const tt = t();
    const { accountId } = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "beeblast-sale-agent-dev",
      email: "owner@example.com",
    });
    const { workspaceId, sandboxId } = await seedWiringFixtures(tt, accountId);

    const agentId = await createAgent(tt, accountId, "beeblast-agent-cust1");
    await tt.mutation(internal.agents.seedEncryptedConfigForTest, {
      agentId: agentId,
      config: {
        model: { provider: "custom", modelId: "Qwen3.6-27B" },
        sandbox: sandboxId,
        workspaces: [{ name: "memory", workspaceId: workspaceId }],
        skills: { enabled: true, allowed: ["beeblast/crm-sync"] },
      },
    });

    const config = await configFor(tt, agentId);
    // The API path owns this config; the canvas locks it accordingly.
    expect(config!.managedBy).toBe("api");

    const layout = await layoutFor(tt, config!);
    const nodes = layout!.nodes as Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>;
    const agentNode = nodes.find((n) => n.data.agentConfigId === config!._id)!;
    expect(agentNode.data.managedBy).toBe("api");

    const workspaceNode = nodes.find((n) => n.type === "workspace")!;
    expect(workspaceNode.data.resourceId).toBe(workspaceId);
    // The agent's ref name, not the row name — a canvas round-trip must
    // derive the same mount the runtime uses.
    expect(workspaceNode.data.mountName).toBe("memory");
    expect(workspaceNode.data.managedBy).toBe("api");
    // The agent-level default sandbox makes the workspace writable.
    expect(workspaceNode.data.readOnly).toBe(false);

    const sandboxNode = nodes.find((n) => n.type === "sandbox")!;
    expect(sandboxNode.data.resourceId).toBe(sandboxId);
    const skillNode = nodes.find((n) => n.type === "skill")!;
    expect(skillNode.data.resourceId).toBe("crm-sync");

    const edges = layout!.edges as Array<{ source: string; target: string }>;
    for (const target of [workspaceNode.id, sandboxNode.id, skillNode.id]) {
      expect(edges).toContainEqual(
        expect.objectContaining({ source: agentNode.id, target: target }),
      );
    }

    // Referenced account-scoped rows are adopted into the canvas environment
    // so the dashboard's save path accepts (and never edits) them.
    await tt.run(async (ctx) => {
      const workspace = await ctx.db.get(workspaceId);
      expect(workspace!.environmentId).toBe(config!.environmentId);
      expect(workspace!.managedBy).toBe("api");
      const sandbox = await ctx.db.get(sandboxId);
      expect(sandbox!.environmentId).toBe(config!.environmentId);
      expect(sandbox!.managedBy).toBe("api");
    });
  });

  test("re-sync prunes wiring the API config no longer declares", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const tt = t();
    const { accountId } = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "beeblast-sale-agent-dev",
      email: "owner@example.com",
    });
    const { workspaceId, sandboxId } = await seedWiringFixtures(tt, accountId);

    const agentId = await createAgent(tt, accountId, "beeblast-agent-cust1");
    /** Writes an encrypted config onto the agent the way an API PATCH does. */
    const seed = (config: Record<string, unknown>) =>
      tt.mutation(internal.agents.seedEncryptedConfigForTest, {
        agentId: agentId,
        config: config,
      });
    await seed({
      sandbox: sandboxId,
      workspaces: [{ name: "memory", workspaceId: workspaceId }],
    });
    await seed({ sandbox: sandboxId });

    const config = await configFor(tt, agentId);
    const layout = await layoutFor(tt, config!);
    const nodes = layout!.nodes as Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>;
    // The dropped workspace ref takes its node and edge with it; the sandbox
    // the config still declares survives.
    expect(nodes.find((n) => n.type === "workspace")).toBeUndefined();
    const sandboxNode = nodes.find((n) => n.type === "sandbox")!;
    expect(sandboxNode.data.resourceId).toBe(sandboxId);
    const edges = layout!.edges as Array<{ source: string; target: string }>;
    expect(edges.some((e) => e.target === sandboxNode.id)).toBe(true);
    expect(edges).toHaveLength(1);
  });

  test("preserves an agent's wiring while its blob cannot be decrypted", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const tt = t();
    const { accountId } = await seedOrg(tt, {
      orgName: "beeblast",
      slug: "beeblast",
      username: "beeblast-sale-agent-dev",
      email: "owner@example.com",
    });
    const { workspaceId, sandboxId } = await seedWiringFixtures(tt, accountId);

    const first = await createAgent(tt, accountId, "beeblast-agent-cust1");
    await tt.mutation(internal.agents.seedEncryptedConfigForTest, {
      agentId: first,
      config: {
        sandbox: sandboxId,
        workspaces: [{ name: "memory", workspaceId: workspaceId }],
      },
    });

    // The first agent's blob becomes unreadable (e.g. written under another
    // secret); a second agent's sync must not prune the first one's wiring.
    await tt.run(async (ctx) => {
      await ctx.db.patch(first, {
        encryptedConfig: "not-decodable",
        encryptionIv: "bad",
        encryptionTag: "bad",
      });
    });
    const second = await createAgent(tt, accountId, "beeblast-agent-cust2");
    await tt.mutation(internal.agents.seedEncryptedConfigForTest, {
      agentId: second,
      config: { sandbox: sandboxId },
    });

    const config = await configFor(tt, first);
    const layout = await layoutFor(tt, config!);
    const nodes = layout!.nodes as Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>;
    const firstNode = nodes.find((n) => n.data.agentConfigId === config!._id)!;
    const workspaceNode = nodes.find((n) => n.type === "workspace")!;
    expect(workspaceNode.data.resourceId).toBe(workspaceId);
    const edges = layout!.edges as Array<{ source: string; target: string }>;
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: firstNode.id,
        target: workspaceNode.id,
      }),
    );
  });
});
