/**
 * Canvas layout persistence keyed by (project, environment).
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { encryptAgentConfigBlob } from "./model/agentConfigCodec";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { getOwnedProject } from "./model/ownership/project";

const canvasNodeValidator = v.object({
    id: v.string(),
    type: v.union(
        v.literal("agent"),
        v.literal("database"),
        v.literal("sandbox"),
        v.literal("workspace"),
        v.literal("tool"),
        v.literal("skill"),
    ),
    position: v.object({ x: v.number(), y: v.number() }),
    data: v.any(),
});

const canvasEdgeValidator = v.object({
    id: v.string(),
    source: v.string(),
    target: v.string(),
    animated: v.optional(v.boolean()),
});

const saveLayoutResult = v.object({
    layoutId: v.id("canvasLayouts"),
    nodes: v.array(canvasNodeValidator),
    edges: v.array(canvasEdgeValidator),
});

type CanvasNode = {
    id: string;
    type: "agent" | "database" | "sandbox" | "workspace" | "tool" | "skill";
    position: { x: number; y: number };
    data: unknown;
};

/** Coerce an unknown canvas node data payload into a mutable record. */
function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

/** Return the org account backing a project, if it has been provisioned. */
async function accountForProject(
    ctx: MutationCtx,
    project: Doc<"projects">,
): Promise<Doc<"accounts"> | null> {
    if (!project.orgId) return null;

    return await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
        .unique();
}

/**
 * Encrypt a plaintext sandbox config object into the at-rest blob fields, or
 * `null` when the encryption secret is unavailable (then the row is stored
 * config-less rather than failing the whole canvas save).
 */
async function encryptSandboxConfigFields(
    config: Record<string, unknown>,
): Promise<{ encryptedConfig: string; encryptionIv: string; encryptionTag: string } | null> {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) return null;
    const encrypted = await encryptAgentConfigBlob(config, secret);

    return {
        encryptedConfig: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
    };
}

/** True when a runtime resource row belongs to the canvas environment being saved. */
function rowBelongsToEnvironment(
    row: Doc<"workspaceConfigs"> | Doc<"sandboxConfigs">,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
): boolean {
    return row.projectId === projectId && row.environmentId === environmentId;
}

/** Compare only the node fields that materialize into runtime resource rows. */
function resourceFieldsChanged(
    next: Record<string, unknown>,
    previous: Record<string, unknown>,
): boolean {
    return (
        String(next.mountName ?? next.label ?? "").trim() !==
            String(previous.mountName ?? previous.label ?? "").trim() ||
        stableJson(next.description ?? null) !== stableJson(previous.description ?? null) ||
        stableJson(next.config ?? null) !== stableJson(previous.config ?? null)
    );
}

/** Deterministic JSON for small config payload comparisons. */
function stableJson(value: unknown): string {
    return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, sortJson(entry)]),
        );
    }

    return value;
}

/** Stable signature of runtime resource references in a canvas node list. */
function resourceReferenceSignature(nodes: CanvasNode[]): string {
    return nodes
        .map((node) => asRecord(node.data).resourceId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .sort()
        .join("\n");
}

/**
 * Reject old account-scoped runtime resources instead of silently creating a new
 * environment-scoped row with the same name and a different runtime id.
 */
async function assertNoAccountScopedResourceConflict(
    ctx: MutationCtx,
    options: {
        table: "workspaceConfigs" | "sandboxConfigs";
        accountId: Id<"accounts">;
        name: string;
    },
): Promise<void> {
    const rows = await ctx.db
        .query(options.table)
        .withIndex("by_accountId_and_name", (q) =>
            q.eq("accountId", options.accountId).eq("name", options.name),
        )
        .collect();
    const accountScoped = rows.find((row) => row.environmentId === undefined);
    if (!accountScoped) return;

    throw new Error(
        `${options.table} "${options.name}" is account-scoped legacy data. ` +
        "Migrate it to a project/environment or delete it before saving the canvas.",
    );
}

/**
 * Ensure canvas workspace/sandbox nodes point at real, environment-scoped core
 * resource rows. Creates a `managedBy: "dashboard"` row for new nodes and patches
 * existing dashboard-owned rows from the node's edited config, so dashboard adds
 * and edits become real (the runtime resolves these rows by `_id`). Rows owned by
 * a `filthypanty/` project (`managedBy: "cli"`) are left untouched — code is their
 * source of truth and the side panel surfaces them as locked.
 */
async function materializeRuntimeNodes(
    ctx: MutationCtx,
    account: Doc<"accounts"> | null,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
    nodes: CanvasNode[],
    previousNodes: CanvasNode[],
): Promise<CanvasNode[]> {
    if (!account) return nodes;

    const previousById = new Map(previousNodes.map((node) => [node.id, node]));
    const result: CanvasNode[] = [];
    for (const node of nodes) {
        if (node.type !== "workspace" && node.type !== "sandbox") {
            result.push(node);
            continue;
        }

        const data = asRecord(node.data);
        const name = String(data.mountName ?? data.label ?? node.type).trim() || node.type;
        const description = typeof data.description === "string" ? data.description : undefined;
        const resourceId = typeof data.resourceId === "string" ? data.resourceId.trim() : "";
        const now = Date.now();
        const previousData = asRecord(previousById.get(node.id)?.data);
        const changed = resourceFieldsChanged(data, previousData);

        if (node.type === "workspace") {
            const config = asRecord(data.config).storage ? data.config : { storage: { provider: "s3" } };
            const normalized = resourceId ? ctx.db.normalizeId("workspaceConfigs", resourceId) : null;
            const byId = normalized ? await ctx.db.get(normalized) : null;
            if (byId && byId.accountId === account._id && !rowBelongsToEnvironment(byId, projectId, environmentId)) {
                throw new Error("Workspace resource belongs to a different project or environment.");
            }
            // Fall back to (environment, name) so a node named like an existing row
            // binds to it instead of inserting a duplicate — duplicates would later
            // break the CLI's by-name `.unique()` lookup on deploy.
            const existing = byId && byId.accountId === account._id
                ? byId
                : await ctx.db
                    .query("workspaceConfigs")
                    .withIndex("by_environmentId_and_name", (q) =>
                        q.eq("environmentId", environmentId).eq("name", name),
                    )
                    .first();
            if (existing && existing.accountId === account._id) {
                // Code owns CLI-managed rows; dashboard edits are not written back.
                if (existing.managedBy !== "cli" && changed) {
                    await ctx.db.patch(existing._id, {
                        projectId: projectId,
                        environmentId: environmentId,
                        name: name,
                        description: description,
                        config: config,
                        managedBy: "dashboard",
                        updatedAt: now,
                    });
                }
                result.push({ ...node, data: { ...data, resourceId: existing._id } });
                continue;
            }

            await assertNoAccountScopedResourceConflict(ctx, {
                table: "workspaceConfigs",
                accountId: account._id,
                name: name,
            });
            const createdId = await ctx.db.insert("workspaceConfigs", {
                accountId: account._id,
                projectId: projectId,
                environmentId: environmentId,
                name: name,
                description: description,
                config: config,
                managedBy: "dashboard",
                createdAt: now,
                updatedAt: now,
            });
            result.push({ ...node, data: { ...data, resourceId: createdId } });
            continue;
        }

        // Sandbox: the config blob is encrypted at rest (may carry provider secrets).
        const sandboxConfig = asRecord(data.config);
        const hasConfig = Object.keys(sandboxConfig).length > 0;
        const encrypted = changed && hasConfig ? await encryptSandboxConfigFields(sandboxConfig) : null;
        const normalized = resourceId ? ctx.db.normalizeId("sandboxConfigs", resourceId) : null;
        const byId = normalized ? await ctx.db.get(normalized) : null;
        if (byId && byId.accountId === account._id && !rowBelongsToEnvironment(byId, projectId, environmentId)) {
            throw new Error("Sandbox resource belongs to a different project or environment.");
        }
        const existing = byId && byId.accountId === account._id
            ? byId
            : await ctx.db
                .query("sandboxConfigs")
                .withIndex("by_environmentId_and_name", (q) =>
                    q.eq("environmentId", environmentId).eq("name", name),
                )
                .first();
        if (existing && existing.accountId === account._id) {
            if (existing.managedBy !== "cli" && changed) {
                await ctx.db.patch(existing._id, {
                    projectId: projectId,
                    environmentId: environmentId,
                    name: name,
                    description: description,
                    managedBy: "dashboard",
                    updatedAt: now,
                    ...(encrypted ?? {}),
                });
            }
            result.push({ ...node, data: { ...data, resourceId: existing._id } });
            continue;
        }

        await assertNoAccountScopedResourceConflict(ctx, {
            table: "sandboxConfigs",
            accountId: account._id,
            name: name,
        });
        const createdId = await ctx.db.insert("sandboxConfigs", {
            accountId: account._id,
            projectId: projectId,
            environmentId: environmentId,
            name: name,
            description: description,
            managedBy: "dashboard",
            createdAt: now,
            updatedAt: now,
            ...(encrypted ?? {}),
        });
        result.push({ ...node, data: { ...data, resourceId: createdId } });
    }

    return result;
}

/**
 * Delete dashboard-owned workspace/sandbox rows in this environment that no
 * canvas node references anymore, making node deletion a real resource delete.
 * CLI-owned (`managedBy: "cli"`) rows are never touched — code owns their
 * lifecycle and prune removes them via the CLI instead.
 */
async function pruneOrphanedDashboardRows(
    ctx: MutationCtx,
    account: Doc<"accounts"> | null,
    environmentId: Id<"environments">,
    persistedNodes: CanvasNode[],
): Promise<void> {
    if (!account) return;

    const referenced = new Set(
        persistedNodes
            .map((node) => asRecord(node.data).resourceId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const workspaces = await ctx.db
        .query("workspaceConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const sandboxes = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();

    for (const row of [...workspaces, ...sandboxes]) {
        if (row.accountId !== account._id) continue;
        if (row.managedBy === "cli") continue;
        if (referenced.has(row._id)) continue;
        await ctx.db.delete(row._id);
    }
}

export const getByProject = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
    },
    returns: v.union(
        v.null(),
        v.object({
            nodes: v.array(canvasNodeValidator),
            edges: v.array(canvasEdgeValidator),
        }),
    ),
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        // Reactive subscribers may briefly hold a just-deleted project/environment;
        // return null instead of throwing so the canvas unmounts without crashing.
        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) return null;

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return null;

        const layout = await ctx.db
            .query("canvasLayouts")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .unique();

        return layout ? { nodes: layout.nodes, edges: layout.edges } : null;
    },
});

export const saveLayout = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        nodes: v.array(canvasNodeValidator),
        edges: v.array(canvasEdgeValidator),
    },
    returns: saveLayoutResult,
    handler: async (ctx, { projectId, environmentId, nodes, edges }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project) throw new Error("Project not found.");

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const now = Date.now();
        const account = await accountForProject(ctx, project);
        const existing = await ctx.db
            .query("canvasLayouts")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .unique();
        const persistedNodes = await materializeRuntimeNodes(
            ctx,
            account,
            projectId,
            environmentId,
            nodes,
            (existing?.nodes ?? []) as CanvasNode[],
        );
        if (
            resourceReferenceSignature(persistedNodes) !==
            resourceReferenceSignature((existing?.nodes ?? []) as CanvasNode[])
        ) {
            await pruneOrphanedDashboardRows(ctx, account, environmentId, persistedNodes);
        }

        if (existing) {
            await ctx.db.patch(existing._id, { nodes: persistedNodes, edges, updatedAt: now });

            return { layoutId: existing._id, nodes: persistedNodes, edges: edges };
        }

        const layoutId = await ctx.db.insert("canvasLayouts", {
            authId: authUser.id,
            projectId,
            environmentId,
            nodes: persistedNodes,
            edges,
            updatedAt: now,
        });

        return { layoutId: layoutId, nodes: persistedNodes, edges: edges };
    },
});

/**
 * Authoritative ownership for an environment's workspace/sandbox resources,
 * keyed by row `_id` (the canvas node's `resourceId`). The side panel reads this
 * — not the cached `managedBy` on canvas node data — so the "managed by code"
 * lock/warning reflects the real row even if the node JSON is stale or missing it.
 */
export const resourceOwnership = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
    },
    returns: v.record(v.string(), v.union(v.literal("cli"), v.literal("dashboard"))),
    handler: async (ctx, { projectId, environmentId }) => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project || !project.orgId) return {};

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return {};

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
            .unique();
        if (!account) return {};

        const workspaces = await ctx.db
            .query("workspaceConfigs")
            .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
            .collect();
        const sandboxes = await ctx.db
            .query("sandboxConfigs")
            .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
            .collect();

        const ownership: Record<string, "cli" | "dashboard"> = {};
        for (const row of [...workspaces, ...sandboxes]) {
            if (row.accountId !== account._id) continue;
            ownership[row._id] = row.managedBy === "cli" ? "cli" : "dashboard";
        }

        return ownership;
    },
});

/**
 * Names of code-managed (`managedBy: "cli"`) resources in this environment, by
 * kind. The side panel uses this to warn when a dashboard-created agent /
 * workspace / sandbox is named the same as a code-managed one — the next
 * `filthy-panty deploy` would adopt and overwrite that resource with the code
 * definition (the CLI resolves by `(environmentId, name)`).
 */
export const cliManagedResourceNames = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
    },
    returns: v.object({
        agent: v.array(v.string()),
        workspace: v.array(v.string()),
        sandbox: v.array(v.string()),
    }),
    handler: async (ctx, { projectId, environmentId }) => {
        const empty = { agent: [], workspace: [], sandbox: [] };
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) throw new Error("User not found or not authenticated");

        const project = await getOwnedProject(ctx, authUser.id, projectId);
        if (!project || !project.orgId) return empty;

        const environment = await getOwnedEnvironment(ctx, authUser.id, environmentId);
        if (!environment || environment.projectId !== projectId) return empty;

        const account = await ctx.db
            .query("accounts")
            .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
            .unique();
        if (!account) return empty;

        const agents = await ctx.db
            .query("agentConfigs")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .collect();
        const workspaces = await ctx.db
            .query("workspaceConfigs")
            .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
            .collect();
        const sandboxes = await ctx.db
            .query("sandboxConfigs")
            .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
            .collect();

        return {
            agent: agents.filter((row) => row.managedBy === "cli").map((row) => row.name),
            workspace: workspaces
                .filter((row) => row.accountId === account._id && row.managedBy === "cli")
                .map((row) => row.name),
            sandbox: sandboxes
                .filter((row) => row.accountId === account._id && row.managedBy === "cli")
                .map((row) => row.name),
        };
    },
});
