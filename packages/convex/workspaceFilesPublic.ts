"use node";
/**
 * Authenticated proxy for mounted workspace files. S3 remains the single source
 * of truth while the service credential and account scope stay server-side.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";
import { authKit } from "./auth";

const fileEntry = v.object({
    path: v.string(),
    name: v.string(),
    isFolder: v.boolean(),
    sizeBytes: v.optional(v.number()),
    updatedAt: v.optional(v.string()),
});

type RuntimeWorkspace = { accountId: Id<"accounts">; workspaceId: Id<"workspaceConfigs"> };
type LegacyFile = {
    _id: Id<"workspaceFiles">;
    path: string;
    isFolder: boolean;
    storageId?: Id<"_storage">;
};

async function requireActionUser(ctx: ActionCtx) {
    const user = await authKit.getAuthUser(ctx);
    if (!user) throw new Error("User not found or not authenticated");

    return user;
}

/** Moves legacy files into S3 when needed and returns the authoritative file list. */
export const migrateLegacy = action({
    args: {
        projectId: v.id("projects"),
        nodeId: v.string(),
        workspaceId: v.string(),
    },
    returns: v.array(fileEntry),
    handler: async (ctx, args) => {
        const user = await requireActionUser(ctx);
        const workspace = await resolveWorkspace(ctx, args);
        const legacyFiles: LegacyFile[] = await ctx.runQuery(internal.workspaceFiles.listForMigrationInternal, {
            authId: user.id,
            projectId: args.projectId,
            nodeId: args.nodeId,
        });
        if (legacyFiles.length === 0) return (await readWorkspaceFiles(workspace)).files;
        const current = await readWorkspaceFiles(workspace);
        const existingPaths = new Set(current.files.map((file) => file.path));
        let changed = false;

        for (const file of legacyFiles) {
            if (!file.isFolder && file.storageId && !existingPaths.has(file.path)) {
                const url: string | null = await ctx.runQuery(internal.workspaceFiles.getFileDownloadUrlInternal, {
                    authId: user.id,
                    projectId: args.projectId,
                    nodeId: args.nodeId,
                    path: file.path,
                });
                if (!url) continue;
                const response = await fetch(url);
                if (!response.ok) continue;
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.byteLength > 512 * 1024) continue;
                await callWorkspaceApi(workspace, "POST", {
                    path: file.path,
                    contentBase64: Buffer.from(bytes).toString("base64"),
                    contentType: response.headers.get("content-type") ?? undefined,
                });
                changed = true;
            }
            await ctx.runMutation(internal.workspaceFiles.removeForMigrationInternal, {
                authId: user.id,
                fileId: file._id,
            });
        }

        return changed ? (await readWorkspaceFiles(workspace)).files : current.files;
    },
});

/** Lists files from the S3 namespace mounted by the selected runtime workspace. */
export const list = action({
    args: { projectId: v.id("projects"), workspaceId: v.string() },
    returns: v.array(fileEntry),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);

        return (await readWorkspaceFiles(workspace)).files;
    },
});

/** Uploads or replaces one file in the mounted S3 workspace. */
export const upload = action({
    args: {
        projectId: v.id("projects"),
        workspaceId: v.string(),
        path: v.string(),
        contentBase64: v.string(),
        contentType: v.optional(v.string()),
    },
    returns: fileEntry,
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);
        const response = await callWorkspaceApi(workspace, "POST", {
            path: args.path,
            contentBase64: args.contentBase64,
            contentType: args.contentType,
        });
        const body = await response.json() as { file: {
            path: string;
            name: string;
            isFolder: boolean;
            sizeBytes?: number;
            updatedAt?: string;
        } };

        return body.file;
    },
});

/** Deletes a file or folder prefix from the mounted S3 workspace. */
export const remove = action({
    args: { projectId: v.id("projects"), workspaceId: v.string(), path: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);
        await callWorkspaceApi(workspace, "DELETE", { path: args.path });

        return null;
    },
});

/** Renames a file or folder prefix inside the mounted S3 workspace. */
export const rename = action({
    args: {
        projectId: v.id("projects"),
        workspaceId: v.string(),
        path: v.string(),
        newPath: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);
        await callWorkspaceApi(workspace, "PATCH", { path: args.path, newPath: args.newPath });

        return null;
    },
});

/** Returns a short-lived S3 download URL for a mounted workspace file. */
export const getDownloadUrl = action({
    args: { projectId: v.id("projects"), workspaceId: v.string(), path: v.string() },
    returns: v.string(),
    handler: async (ctx, args) => {
        const workspace = await resolveWorkspace(ctx, args);
        const response = await callWorkspaceApi(workspace, "GET", undefined, args.path);
        const body = await response.json() as { url: string };

        return body.url;
    },
});

async function resolveWorkspace(
    ctx: ActionCtx,
    args: { projectId: Id<"projects">; workspaceId: string },
): Promise<RuntimeWorkspace> {
    const user = await requireActionUser(ctx);
    const workspace: RuntimeWorkspace | null = await ctx.runQuery(internal.workspaceFiles.resolveRuntimeWorkspaceInternal, {
        authId: user.id,
        projectId: args.projectId,
        workspaceId: args.workspaceId,
    });
    if (!workspace) throw new Error("Workspace not found");

    return workspace;
}

async function callWorkspaceApi(
    workspace: RuntimeWorkspace,
    method: string,
    body?: Record<string, unknown>,
    path?: string,
): Promise<Response> {
    const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
    const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
    if (!url || !secret) throw new Error("Workspace file service is not configured");
    const endpoint = `${url.replace(/\/+$/, "")}/accounts/me/workspaces/${encodeURIComponent(workspace.workspaceId)}/files` +
        (path ? `?path=${encodeURIComponent(path)}` : "");
    const response = await fetch(endpoint, {
        method: method,
        headers: {
            "Authorization": `Bearer ${secret}`,
            "X-Account-Id": workspace.accountId,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Workspace file request failed (${response.status}): ${await response.text()}`);

    return response;
}

async function readWorkspaceFiles(workspace: RuntimeWorkspace): Promise<{ files: Array<{
    path: string;
    name: string;
    isFolder: boolean;
    sizeBytes?: number;
    updatedAt?: string;
}> }> {
    const response = await callWorkspaceApi(workspace, "GET");

    return await response.json() as { files: Array<{
        path: string;
        name: string;
        isFolder: boolean;
        sizeBytes?: number;
        updatedAt?: string;
    }> };
}
