/**
 * Workspace file routes: list/upload/rename/delete under
 * `/v1/workspaces/{id}/files`, capability-link minting under
 * `/v1/workspaces/{id}/download-links`, and the unauthenticated token
 * redemption at `/v1/downloads/{token}`.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { sha256Hex } from "../../model/accountSecrets";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import {
  normalizeFilePath,
  normalizeWorkspaceConfig,
} from "../../model/workspaceRules";
import {
  DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS,
  MAX_DOWNLOAD_TOKEN_TTL_SECONDS,
} from "../../workspace/files";
import { json, methodNotAllowed, writeAudit } from "./shared";

export const DOWNLOAD_ROUTE_PREFIX = "/v1/downloads/";

/**
 * Redeem a capability link: mint a presigned S3 URL and redirect to it. The
 * signed URL never touches a chat client, which is the whole point — an unknown,
 * expired or revoked token is a flat 404 so the route cannot be used as an oracle.
 */
export async function handleDownloadRedeemRoute(
  ctx: ActionCtx,
  req: Request,
  token: string,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD")
    return methodNotAllowed(["GET", "HEAD"]);

  const now = Date.now();
  const resolved = await ctx.runQuery(internal.workspace.files.resolveByHash, {
    tokenHash: await sha256Hex(token),
    now: now,
  });
  if (!resolved) return json({ error: "Not found" }, 404);

  const workspace = await ctx.runQuery(internal.workspace.configs.getById, {
    accountId: resolved.accountId,
    workspaceId: resolved.workspaceId,
  });
  if (!workspace) return json({ error: "Not found" }, 404);

  let url: string;
  try {
    url = await ctx.runAction(internal.aws.workspaceFiles.downloadUrl, {
      accountId: resolved.accountId,
      workspaceId: resolved.workspaceId,
      storage: normalizeWorkspaceConfig(workspace.config).storage,
      path: resolved.path,
    });
  } catch {
    return json({ error: "Not found" }, 404);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
      // The link is a bearer credential; keep it out of referrers and indexes.
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * Mint a capability link for one workspace file. Returns the token and the path
 * to join to the base URL the caller reached us on — the config plane sits behind
 * the gateway, which strips Host, so it cannot know its own public origin.
 */
export async function handleWorkspaceDownloadLinkRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  workspaceId: string,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const workspace = await ctx.runQuery(internal.workspace.configs.getById, {
    accountId: accountId,
    workspaceId: workspaceId,
  });
  if (!workspace) return json({ error: "Workspace not found" }, 404);

  const body = (await req.json()) as {
    path?: unknown;
    expiresInSeconds?: unknown;
  };
  if (typeof body.path !== "string")
    return json({ error: "path is required" }, 400);
  const ttl = parseDownloadTtlSeconds(body.expiresInSeconds);
  if (ttl instanceof Response) return ttl;
  const path = normalizeFilePath(body.path);

  // Presigning now proves the file exists and that we can read it, so a link is
  // never handed out for something that will 404 when someone follows it.
  try {
    await ctx.runAction(internal.aws.workspaceFiles.downloadUrl, {
      accountId: accountId,
      workspaceId: workspace._id,
      storage: normalizeWorkspaceConfig(workspace.config).storage,
      path: path,
    });
  } catch {
    return json({ error: "Workspace file not found" }, 404);
  }

  const now = Date.now();
  const token = generateDownloadToken();
  await ctx.runMutation(internal.workspace.files.createDownloadToken, {
    accountId: accountId,
    workspaceId: workspace._id,
    path: path,
    filename: path.split("/").at(-1)!,
    tokenHash: await sha256Hex(token),
    expiresAt: now + ttl * 1000,
    now: now,
  });
  await writeAudit(ctx, {
    accountId: accountId,
    projectId: workspace.projectId,
    stageId: workspace.stageId,
    actor: actor,
    action: "file-link-created",
    resource: { kind: "workspaceFile", id: workspace._id, name: path },
    summary: "Workspace download link created",
    detailsJson: auditDetailsJson({
      workspaceId: workspace._id,
      path: path,
      expiresInSeconds: ttl,
    }),
  });

  return json({
    token: token,
    downloadPath: `${DOWNLOAD_ROUTE_PREFIX}${token}`,
    path: path,
    expiresInSeconds: ttl,
  });
}

/**
 * Workspace files: list/presign on GET, upload on POST, rename on PATCH,
 * delete on DELETE. Mirrors core's former handleWorkspaceFilesRoute contract.
 */
export async function handleWorkspaceFilesRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  workspaceId: string,
): Promise<Response> {
  const workspace = await ctx.runQuery(internal.workspace.configs.getById, {
    accountId: accountId,
    workspaceId: workspaceId,
  });
  if (!workspace) return json({ error: "Workspace not found" }, 404);
  const target = {
    accountId: accountId,
    workspaceId: workspace._id,
    storage: normalizeWorkspaceConfig(workspace.config).storage,
  };

  if (req.method === "GET") {
    const path = new URL(req.url).searchParams.get("path");
    if (path) {
      return json({
        url: await ctx.runAction(internal.aws.workspaceFiles.downloadUrl, {
          ...target,
          path: path,
        }),
      });
    }

    return json({
      files: await ctx.runAction(internal.aws.workspaceFiles.list, target),
    });
  }
  if (req.method === "POST") {
    const body = (await req.json()) as {
      path?: unknown;
      contentBase64?: unknown;
      contentType?: unknown;
    };
    if (
      typeof body.path !== "string" ||
      typeof body.contentBase64 !== "string"
    ) {
      return json({ error: "path and contentBase64 are required" }, 400);
    }
    const file = await ctx.runAction(internal.aws.workspaceFiles.upload, {
      ...target,
      path: body.path,
      contentBase64: body.contentBase64,
      ...(typeof body.contentType === "string"
        ? { contentType: body.contentType }
        : {}),
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: workspace.projectId,
      stageId: workspace.stageId,
      actor: actor,
      action: "file-uploaded",
      resource: { kind: "workspaceFile", id: workspace._id, name: body.path },
      summary: "Workspace file uploaded",
      detailsJson: auditDetailsJson({
        workspaceId: workspace._id,
        path: body.path,
      }),
    });

    return json({ file: file }, 201);
  }
  if (req.method === "PATCH") {
    const body = (await req.json()) as { path?: unknown; newPath?: unknown };
    if (typeof body.path !== "string" || typeof body.newPath !== "string") {
      return json({ error: "path and newPath are required" }, 400);
    }
    const renamed = await ctx.runAction(
      internal.aws.workspaceFiles.renamePath,
      {
        ...target,
        path: body.path,
        newPath: body.newPath,
      },
    );
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: workspace.projectId,
      stageId: workspace.stageId,
      actor: actor,
      action: "file-updated",
      resource: {
        kind: "workspaceFile",
        id: workspace._id,
        name: body.newPath,
      },
      summary: "Workspace file updated",
      detailsJson: auditDetailsJson({
        workspaceId: workspace._id,
        path: body.path,
        newPath: body.newPath,
      }),
    });

    return json({ renamed: renamed });
  }
  if (req.method === "DELETE") {
    const body = (await req.json()) as { path?: unknown };
    if (typeof body.path !== "string")
      return json({ error: "path is required" }, 400);
    const deleted = await ctx.runAction(
      internal.aws.workspaceFiles.removePath,
      {
        ...target,
        path: body.path,
      },
    );
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: workspace.projectId,
        stageId: workspace.stageId,
        actor: actor,
        action: "file-deleted",
        resource: { kind: "workspaceFile", id: workspace._id, name: body.path },
        summary: "Workspace file deleted",
        detailsJson: auditDetailsJson({
          workspaceId: workspace._id,
          path: body.path,
        }),
      });
    }

    return json({ deleted: deleted });
  }

  return methodNotAllowed(["GET", "POST", "PATCH", "DELETE"]);
}

/**
 * Match a download-token redemption and return the raw token. Kept separate from
 * parseRoute because this one route runs before authentication.
 * @param pathname request path
 * @returns the token, or null when the path is not a redemption
 */
export function parseDownloadRoute(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/downloads\/([A-Za-z0-9_-]{16,128})$/);

  return match?.[1] ?? null;
}

/**
 * Mint a download token. base64url only: a `+` in a link is exactly the bug this
 * route exists to avoid, since chat clients decode it back into a space.
 * @returns a 256-bit URL-safe token
 */
function generateDownloadToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Read the requested token lifetime, defaulting and capping it.
 * @param value client-supplied expiresInSeconds
 * @returns the lifetime in seconds, or a 400 response
 */
function parseDownloadTtlSeconds(value: unknown): number | Response {
  if (value === undefined) return DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_DOWNLOAD_TOKEN_TTL_SECONDS
  ) {
    return json(
      {
        error: `expiresInSeconds must be an integer between 1 and ${MAX_DOWNLOAD_TOKEN_TTL_SECONDS}`,
      },
      400,
    );
  }

  return value;
}
