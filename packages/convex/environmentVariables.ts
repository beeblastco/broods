/**
 * Public CRUD for per-environment runtime variables, mirrored into the CLI
 * sync model. Scoped to the authenticated project owner.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedEnvironment } from "./model/ownership/environment";
import { decryptAgentConfigBlob, encryptAgentConfigBlob } from "./model/agentConfigCodec";
import { refreshAgentConfigsForEnvironmentVariable } from "./model/agentSync";
import { refreshSandboxConfigsForEnvironmentVariable } from "./model/sandboxConfigSync";
import { scheduleServiceLog } from "./observability";

const environmentVariableDoc = v.object({
    _id: v.id("environmentVariables"),
    _creationTime: v.number(),
    projectId: v.id("projects"),
    environmentId: v.id("environments"),
    name: v.string(),
    value: v.string(),
    updatedAt: v.number(),
});

function encryptionSecret(): string {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store environment variables");
    }

    return secret;
}

function maskEnvironmentVariable(variable: {
    _id: Id<"environmentVariables">;
    _creationTime: number;
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    name: string;
    updatedAt: number;
}) {
    return {
        _id: variable._id,
        _creationTime: variable._creationTime,
        projectId: variable.projectId,
        environmentId: variable.environmentId,
        name: variable.name,
        value: "********",
        updatedAt: variable.updatedAt,
    };
}

export const list = query({
    args: { projectId: v.id("projects"), environmentId: v.id("environments") },
    returns: v.array(environmentVariableDoc),
    handler: async (ctx, { projectId, environmentId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        // Return empty rather than throwing so a just-deleted environment doesn't
        // crash reactive subscribers before they unmount.
        const environment = await getOwnedEnvironment(ctx, user.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            return [];
        }

        const variables = await ctx.db
            .query("environmentVariables")
            .withIndex("by_projectId_and_environmentId", (q) =>
                q.eq("projectId", projectId).eq("environmentId", environmentId),
            )
            .collect();

        return variables.map(maskEnvironmentVariable);
    },
});

/**
 * Upserts a variable by name within an environment: patches the value when the
 * name already exists, otherwise inserts a new row.
 */
export const set = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        name: v.string(),
        value: v.string(),
    },
    returns: v.id("environmentVariables"),
    handler: async (ctx, { projectId, environmentId, name, value }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const environment = await getOwnedEnvironment(ctx, user.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Variable name is required.");

        const existing = await ctx.db
            .query("environmentVariables")
            .withIndex("by_environmentId_and_name", (q) =>
                q.eq("environmentId", environmentId).eq("name", trimmedName),
            )
            .unique();

        const now = Date.now();
        const encrypted = await encryptAgentConfigBlob({ value: value }, encryptionSecret());
        if (existing) {
            await ctx.db.patch(existing._id, {
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                tag: encrypted.tag,
                updatedAt: now,
            });

            await refreshAgentConfigsForEnvironmentVariable(
                ctx,
                projectId,
                environmentId,
                trimmedName,
                value,
            );
            await refreshSandboxConfigsForEnvironmentVariable(
                ctx,
                projectId,
                environmentId,
                trimmedName,
                value,
            );
            await scheduleServiceLog(ctx, {
                projectId: projectId,
                environmentId: environmentId,
                eventType: "service.environment.variable.updated",
                message: "Environment variable updated",
                data: { name: trimmedName },
            });

            return existing._id;
        }

        const variableId = await ctx.db.insert("environmentVariables", {
            projectId: projectId,
            environmentId: environmentId,
            name: trimmedName,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            tag: encrypted.tag,
            updatedAt: now,
        });

        await refreshAgentConfigsForEnvironmentVariable(
            ctx,
            projectId,
            environmentId,
            trimmedName,
            value,
        );
        await refreshSandboxConfigsForEnvironmentVariable(
            ctx,
            projectId,
            environmentId,
            trimmedName,
            value,
        );
        await scheduleServiceLog(ctx, {
            projectId: projectId,
            environmentId: environmentId,
            eventType: "service.environment.variable.created",
            message: "Environment variable created",
            data: { name: trimmedName },
        });

        return variableId;
    },
});

/**
 * Decrypts and returns one variable's plaintext value for the dashboard eye-icon
 * reveal, writing an audit record of the reveal. A mutation (not a query) so the
 * audit insert and decryption happen atomically for the owning user.
 * @throws when the caller does not own the environment or the variable is gone
 */
export const reveal = mutation({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
        variableId: v.id("environmentVariables"),
    },
    returns: v.object({ value: v.string() }),
    handler: async (ctx, { projectId, environmentId, variableId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const environment = await getOwnedEnvironment(ctx, user.id, environmentId);
        if (!environment || environment.projectId !== projectId) {
            throw new Error("Environment not found.");
        }

        const variable = await ctx.db.get(variableId);
        if (!variable || variable.environmentId !== environmentId) {
            throw new Error("Variable not found.");
        }

        const decrypted = await decryptAgentConfigBlob(
            { ciphertext: variable.ciphertext, iv: variable.iv, tag: variable.tag },
            encryptionSecret(),
        );
        const revealed = decrypted as { value?: unknown } | null;
        const value = typeof revealed?.value === "string" ? revealed.value : "";

        await ctx.db.insert("environmentVariableReveals", {
            projectId: projectId,
            environmentId: environmentId,
            environmentVariableId: variableId,
            name: variable.name,
            source: "dashboard",
            revealedByAuthId: user.id,
            revealedAt: Date.now(),
        });

        return { value: value };
    },
});

export const remove = mutation({
    args: { variableId: v.id("environmentVariables") },
    returns: v.id("environmentVariables"),
    handler: async (ctx, { variableId }) => {
        // Check authenticated user
        const user = await authKit.getAuthUser(ctx);
        if (!user) {
            throw new Error("User not found or not authenticated");
        }

        const variable = await ctx.db.get(variableId);
        if (!variable) throw new Error("Variable not found.");

        const environment = await getOwnedEnvironment(ctx, user.id, variable.environmentId);
        if (!environment) throw new Error("Variable not found.");

        await ctx.db.delete(variableId);
        await refreshAgentConfigsForEnvironmentVariable(
            ctx,
            variable.projectId,
            variable.environmentId,
            variable.name,
            undefined,
        );
        await refreshSandboxConfigsForEnvironmentVariable(
            ctx,
            variable.projectId,
            variable.environmentId,
            variable.name,
            undefined,
        );
        await scheduleServiceLog(ctx, {
            projectId: variable.projectId,
            environmentId: variable.environmentId,
            eventType: "service.environment.variable.deleted",
            message: "Environment variable deleted",
            data: { name: variable.name },
        });

        return variableId;
    },
});
