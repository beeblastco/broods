/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** Seeds an org owned by `email`, its account, and the owner membership. */
async function seedOrg(
    tt: T,
    opts: { orgName: string; slug: string; username: string; email: string; onboardedAt?: number },
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

        await ctx.db.insert("orgMembers", { orgId, userId, role: "owner" as const, createdAt: now });

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

        const agentId = await createAgent(tt, beeblast.accountId, "beeblast-agent-cust1");

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
});

describe("backfillCanvasLinks", () => {
    test("links agents stranded by an unadopted account, and is idempotent", async () => {
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

        // Adopt: bind the account to a real org with an owner.
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
        });

        const first = await tt.mutation(internal.agents.backfillCanvasLinks, { accountId });
        expect(first).toEqual({ scanned: 1, linked: 1 });
        expect(await configFor(tt, stranded)).not.toBeNull();

        // Re-running must not duplicate the config row.
        const second = await tt.mutation(internal.agents.backfillCanvasLinks, { accountId });
        expect(second).toEqual({ scanned: 1, linked: 0 });
    });
});
