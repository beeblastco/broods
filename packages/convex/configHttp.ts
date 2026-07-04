/**
 * Public config-plane HTTP surface (epic #85 phase 9): skills, tools, and
 * workspace files CRUD served straight from Convex, replacing core's former
 * /v1/{skills,tools} and /v1/workspaces/{id}/files routes. The gateway
 * forwards these paths here; response shapes match the retired core handlers
 * so the public API contract is unchanged. Auth is the account Bearer secret.
 */

import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeAccountToolUpload } from "./model/accountTools";

export const handle = httpAction(async (ctx, req) => {
    try {
        const account = await requireAccount(ctx, req);
        if (!account) return json({ error: "Unauthorized" }, 401);
        const route = parseRoute(new URL(req.url).pathname);
        if (!route) return json({ error: "Not found" }, 404);

        switch (route.kind) {
            case "skills":
                return await handleSkillRoute(ctx, req, account._id, route.name);
            case "tools":
                return await handleToolRoute(ctx, req, account._id, route.toolId);
            case "workspaceFiles":
                return await handleWorkspaceFilesRoute(ctx, req, account._id, route.workspaceId);
        }
    } catch (err) {
        if (isClientInputError(err)) {
            return json({ error: err.message }, 400);
        }
        console.error("config HTTP request failed", err);

        return json({ error: "Internal server error" }, 500);
    }
});

type ConfigRoute =
    | { kind: "skills"; name?: string }
    | { kind: "tools"; toolId?: string }
    | { kind: "workspaceFiles"; workspaceId: string };

/**
 * Parse a config-plane pathname into its route parts.
 * @param pathname the request pathname
 * @returns the parsed route, or null when the path is not a config route
 */
function parseRoute(pathname: string): ConfigRoute | null {
    const skills = pathname.match(/^\/v1\/skills(?:\/([^/]+))?$/);
    if (skills) return { kind: "skills", ...(skills[1] ? { name: decodeURIComponent(skills[1]) } : {}) };

    const tools = pathname.match(/^\/v1\/tools(?:\/([^/]+))?$/);
    if (tools) return { kind: "tools", ...(tools[1] ? { toolId: decodeURIComponent(tools[1]) } : {}) };

    const files = pathname.match(/^\/v1\/workspaces\/([^/]+)\/files$/);
    if (files?.[1]) return { kind: "workspaceFiles", workspaceId: decodeURIComponent(files[1]) };

    return null;
}

/**
 * Resolve the Bearer token to an account.
 * @param ctx the action context
 * @param req the incoming request
 * @returns the account document, or null when the token is missing or unknown
 */
async function requireAccount(ctx: ActionCtx, req: Request): Promise<Doc<"accounts"> | null> {
    const header = req.headers.get("Authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
    const secretHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return await ctx.runQuery(internal.accounts.getBySecretHash, { secretHash: secretHash });
}

/**
 * Skills CRUD: list/create on the collection, get/replace/delete by name.
 * Mirrors core's former handleSkillRoute contract.
 */
async function handleSkillRoute(ctx: ActionCtx, req: Request, accountId: Id<"accounts">, name?: string): Promise<Response> {
    if (!name) {
        if (req.method === "GET") {
            const skills = await ctx.runAction(internal.awsSkills.list, { accountId: accountId });

            return json({ skills: skills });
        }
        if (req.method === "POST") {
            const skill = await ctx.runAction(internal.awsSkills.createSkill, {
                accountId: accountId,
                input: await req.json(),
            });

            return json(skill, 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const skill = await ctx.runAction(internal.awsSkills.get, { accountId: accountId, skillName: name });

        return skill ? json(skill) : json({ error: "Skill not found" }, 404);
    }
    if (req.method === "PUT") {
        const skill = await ctx.runAction(internal.awsSkills.createSkill, {
            accountId: accountId,
            input: await req.json(),
            expectedName: name,
        });

        return json(skill);
    }
    if (req.method === "DELETE") {
        const deleted = await ctx.runAction(internal.awsSkills.remove, { accountId: accountId, skillName: name });

        return deleted ? json({ deleted: true }) : json({ error: "Skill not found" }, 404);
    }

    return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

/**
 * Tools CRUD: list/create on the collection, get/patch/delete by id. Bundle
 * bytes go to S3 via awsBundles; metadata lives in the accountTools table.
 * Mirrors core's former handleToolRoute contract.
 */
async function handleToolRoute(ctx: ActionCtx, req: Request, accountId: Id<"accounts">, toolId?: string): Promise<Response> {
    if (!toolId) {
        if (req.method === "GET") {
            const records = await ctx.runQuery(internal.accountTools.list, { accountId: accountId });

            return json({ tools: records.map((record) => toPublicAccountTool(record)) });
        }
        if (req.method === "POST") {
            const upload = await normalizeAccountToolUpload(await req.json(), { requireBundle: true });
            const bundleStorageKey = await ctx.runAction(internal.awsBundles.putToolBundle, {
                accountId: accountId,
                sha256: upload.sha256,
                bundle: upload.bundle,
            });
            const createdId = await ctx.runMutation(internal.accountTools.create, {
                accountId: accountId,
                name: upload.name,
                description: upload.description,
                inputSchema: upload.inputSchema,
                bundleStorageKey: bundleStorageKey,
                sha256: upload.sha256,
                ...(upload.defaultConfig !== undefined ? { defaultConfig: upload.defaultConfig } : {}),
            });
            const created = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: createdId });

            return json(toPublicAccountTool(created!), 201);
        }

        return methodNotAllowed(["GET", "POST"]);
    }

    if (req.method === "GET") {
        const record = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });

        return record && record.status === "active"
            ? json(toPublicAccountTool(record))
            : json({ error: "Tool not found" }, 404);
    }
    if (req.method === "PATCH") {
        const existing = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });
        if (!existing || existing.status !== "active") return json({ error: "Tool not found" }, 404);
        const upload = await normalizeAccountToolUpload(await req.json(), { requireBundle: false });
        const bundleStorageKey = upload.bundle !== undefined && upload.sha256 !== undefined
            ? await ctx.runAction(internal.awsBundles.putToolBundle, {
                accountId: accountId,
                sha256: upload.sha256,
                bundle: upload.bundle,
            })
            : undefined;
        await ctx.runMutation(internal.accountTools.update, {
            accountId: accountId,
            toolId: toolId,
            ...(upload.name !== undefined ? { name: upload.name } : {}),
            ...(upload.description !== undefined ? { description: upload.description } : {}),
            ...(upload.inputSchema !== undefined ? { inputSchema: upload.inputSchema } : {}),
            ...(bundleStorageKey !== undefined ? { bundleStorageKey: bundleStorageKey, sha256: upload.sha256 } : {}),
            ...(upload.defaultConfig !== undefined ? { defaultConfig: upload.defaultConfig } : {}),
        });
        const updated = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });

        return updated ? json(toPublicAccountTool(updated)) : json({ error: "Tool not found" }, 404);
    }
    if (req.method === "DELETE") {
        const existing = await ctx.runQuery(internal.accountTools.getById, { accountId: accountId, toolId: toolId });
        if (!existing || existing.status !== "active") return json({ error: "Tool not found" }, 404);
        await ctx.runMutation(internal.accountTools.remove, { accountId: accountId, toolId: toolId });

        return json({ deleted: true });
    }

    return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Workspace files: list/presign on GET, upload on POST, rename on PATCH,
 * delete on DELETE. Mirrors core's former handleWorkspaceFilesRoute contract.
 */
async function handleWorkspaceFilesRoute(
    ctx: ActionCtx,
    req: Request,
    accountId: Id<"accounts">,
    workspaceId: string,
): Promise<Response> {
    const workspace = await ctx.runQuery(internal.workspaceConfigs.getById, {
        accountId: accountId,
        workspaceId: workspaceId,
    });
    if (!workspace) return json({ error: "Workspace not found" }, 404);
    const target = { accountId: accountId, workspaceId: workspace._id };

    if (req.method === "GET") {
        const path = new URL(req.url).searchParams.get("path");
        if (path) {
            return json({ url: await ctx.runAction(internal.awsWorkspaceFiles.downloadUrl, { ...target, path: path }) });
        }

        return json({ files: await ctx.runAction(internal.awsWorkspaceFiles.list, target) });
    }
    if (req.method === "POST") {
        const body = await req.json() as { path?: unknown; contentBase64?: unknown; contentType?: unknown };
        if (typeof body.path !== "string" || typeof body.contentBase64 !== "string") {
            return json({ error: "path and contentBase64 are required" }, 400);
        }
        const file = await ctx.runAction(internal.awsWorkspaceFiles.upload, {
            ...target,
            path: body.path,
            contentBase64: body.contentBase64,
            ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
        });

        return json({ file: file }, 201);
    }
    if (req.method === "PATCH") {
        const body = await req.json() as { path?: unknown; newPath?: unknown };
        if (typeof body.path !== "string" || typeof body.newPath !== "string") {
            return json({ error: "path and newPath are required" }, 400);
        }
        const renamed = await ctx.runAction(internal.awsWorkspaceFiles.renamePath, {
            ...target,
            path: body.path,
            newPath: body.newPath,
        });

        return json({ renamed: renamed });
    }
    if (req.method === "DELETE") {
        const body = await req.json() as { path?: unknown };
        if (typeof body.path !== "string") return json({ error: "path is required" }, 400);
        const deleted = await ctx.runAction(internal.awsWorkspaceFiles.removePath, { ...target, path: body.path });

        return json({ deleted: deleted });
    }

    return methodNotAllowed(["GET", "POST", "PATCH", "DELETE"]);
}

/**
 * Map an accountTools document to the public tool shape core used to return.
 * @param record the accountTools document
 * @returns the public record with toolId and ISO timestamps
 */
function toPublicAccountTool(record: Doc<"accountTools">): Record<string, unknown> {
    return {
        accountId: record.accountId,
        toolId: record._id,
        name: record.name,
        description: record.description,
        inputSchema: record.inputSchema,
        sha256: record.sha256,
        ...(record.defaultConfig !== undefined ? { defaultConfig: record.defaultConfig } : {}),
        status: record.status,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        ...(record.deletedAt ? { deletedAt: new Date(record.deletedAt).toISOString() } : {}),
    };
}

function methodNotAllowed(allowedMethods: string[]): Response {
    return json({ error: "Method not allowed", allowedMethods: allowedMethods }, 405);
}

function isClientInputError(error: unknown): error is Error {
    if (!(error instanceof Error)) return false;
    if (error instanceof SyntaxError) return true;
    return [
        "tool.",
        "Request body",
        "source must",
        "files must",
        "Each file",
        "JSON skills",
        "Skill ",
        "Duplicate skill ",
        "Invalid skill ",
        "SKILL.md ",
        "GitHub skill URL ",
        "GitHub archive ",
        "url must ",
        "path ",
        "path and ",
        "contentBase64 ",
        "Invalid workspace path",
        "Invalid destination path",
        "Workspace uploads ",
        "Workspace file not found",
        "Workspace path not found",
    ].some((prefix) => error.message.startsWith(prefix));
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status: status,
        headers: { "Content-Type": "application/json" },
    });
}
