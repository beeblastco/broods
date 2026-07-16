/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import { agentsInProject, cronsInProject } from "./model/projectScope";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

// The public queries wrap these helpers behind getProjectForRole, which needs
// the WorkOS AuthKit component that convex-test does not register here. The
// derivation below is the part unique to project scoping, so it is tested
// directly against a real ctx.

async function seed(tt: T) {
    return await tt.run(async (ctx) => {
        const now = Date.now();
        const accountId = await ctx.db.insert("accounts", {
            orgId: "org-placeholder",
            username: "beeblast-sale-agent-dev",
            secretHash: "hash",
            status: "active" as const,
            createdAt: now,
            updatedAt: now,
        });

        const mkProject = async (name: string) =>
            await ctx.db.insert("projects", {
                authId: "auth_owner",
                name: name,
                slug: name,
                updatedAt: now,
            });
        const mkEnv = async (projectId: Id<"projects">) =>
            await ctx.db.insert("environments", {
                authId: "auth_owner",
                projectId: projectId,
                name: "Development",
                isDefault: true,
                updatedAt: now,
            });
        const mkAgent = async (name: string) =>
            await ctx.db.insert("agents", {
                accountId: accountId,
                name: name,
                createdAt: now,
                updatedAt: now,
            });
        const mkConfig = async (
            projectId: Id<"projects">,
            environmentId: Id<"environments">,
            agentId: string | undefined,
            name: string,
        ) =>
            await ctx.db.insert("agentConfigs", {
                authId: "auth_owner",
                name: name,
                agentId: agentId,
                projectId: projectId,
                environmentId: environmentId,
                updatedAt: now,
            });
        const mkCron = async (agentId: Id<"agents">, name: string) =>
            await ctx.db.insert("crons", {
                accountId: accountId,
                name: name,
                agentId: agentId,
                events: [],
                scheduleExpression: "rate(1 day)",
                status: "active" as const,
                schedulerName: "s-" + name,
                schedulerGroupName: "g",
                createdAt: now,
                updatedAt: now,
            });

        const projectA = await mkProject("sale-agent");
        const projectB = await mkProject("other");
        const envA1 = await mkEnv(projectA);
        const envA2 = await mkEnv(projectA);
        const envB = await mkEnv(projectB);

        const agentA1 = await mkAgent("beeblast-agent-cust1");
        const agentA2 = await mkAgent("beeblast-agent-cust2");
        const agentB = await mkAgent("other-agent");
        const stranded = await mkAgent("pre-adoption-agent");

        // An agent on a different account entirely, pointed at by a config row
        // in this project — agentConfigs.agentId is a loose string, so a stale
        // or hand-edited row can name anything that resolves.
        const foreignAccountId = await ctx.db.insert("accounts", {
            orgId: "org-other",
            username: "someone-elses-account",
            secretHash: "hash-other",
            status: "active" as const,
            createdAt: now,
            updatedAt: now,
        });
        const foreignAgent = await ctx.db.insert("agents", {
            accountId: foreignAccountId,
            name: "someone-elses-agent",
            createdAt: now,
            updatedAt: now,
        });

        await mkConfig(projectA, envA1, agentA1, "cust1");
        // Second environment of the same project: must still be found.
        await mkConfig(projectA, envA2, agentA2, "cust2");
        await mkConfig(projectB, envB, agentB, "other");
        // A config row whose agentId never resolves must not crash the scan.
        await mkConfig(projectA, envA1, "not-a-real-id", "dangling");
        await mkConfig(projectA, envA1, foreignAgent, "foreign");

        const cronA1 = await mkCron(agentA1, "cron-a1");
        await mkCron(agentB, "cron-b");
        const cronStranded = await mkCron(stranded, "cron-stranded");

        return {
            accountId, projectA, projectB,
            agentA1, agentA2, agentB, stranded, foreignAgent,
            cronA1, cronStranded,
        };
    });
}

describe("agentsInProject", () => {
    test("returns the project's agents across every environment", async () => {
        const tt = t();
        const s = await seed(tt);

        const found = await tt.run((ctx) => agentsInProject(ctx, s.projectA, s.accountId));
        expect(found.map((a) => a._id).sort()).toEqual([s.agentA1, s.agentA2].sort());
    });

    test("excludes another project's agents on the same account", async () => {
        const tt = t();
        const s = await seed(tt);

        const found = await tt.run((ctx) => agentsInProject(ctx, s.projectA, s.accountId));
        expect(found.map((a) => a._id)).not.toContain(s.agentB);
    });

    test("excludes an agent owned by another account", async () => {
        const tt = t();
        const s = await seed(tt);

        // Otherwise another account's agent metadata surfaces in this
        // project's scheduler and offers a picker option that cannot work.
        const found = await tt.run((ctx) => agentsInProject(ctx, s.projectA, s.accountId));
        expect(found.map((a) => a._id)).not.toContain(s.foreignAgent);
    });

    test("omits agents with no config row rather than throwing", async () => {
        const tt = t();
        const s = await seed(tt);

        // The pre-adoption agents' state: real, running, but in no project.
        const found = await tt.run((ctx) => agentsInProject(ctx, s.projectA, s.accountId));
        expect(found.map((a) => a._id)).not.toContain(s.stranded);
    });
});

describe("cronsInProject", () => {
    test("derives a cron's project from the agent it runs", async () => {
        const tt = t();
        const s = await seed(tt);

        const found = await tt.run((ctx) => cronsInProject(ctx, s.projectA, s.accountId));
        expect(found.map((c) => c._id)).toEqual([s.cronA1]);
    });

    test("hides crons whose agent belongs to no project", async () => {
        const tt = t();
        const s = await seed(tt);

        const a = await tt.run((ctx) => cronsInProject(ctx, s.projectA, s.accountId));
        const b = await tt.run((ctx) => cronsInProject(ctx, s.projectB, s.accountId));
        // Previously every cron on the account showed on one org-wide page, so
        // this one had somewhere to appear; now it must not leak into a project.
        expect([...a, ...b].map((c) => c._id)).not.toContain(s.cronStranded);
    });
});
