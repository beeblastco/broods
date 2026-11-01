import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { sha256Hex } from "../../model/accountSecrets";
import { auditDetailsJson, type AuditActor } from "../../model/auditEvents";
import {
  normalizeFilePath,
  normalizeWorkspaceConfig,
} from "../../model/workspaceRules";
import {
  DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS,
  MAX_DOWNLOAD_TOKEN_TTL_SECONDS,
} from "../../workspace/files";
import { json, jsonError, methodNotAllowed, writeAudit } from "./shared";

export const DOWNLOAD_ROUTE_PREFIX = "/v1/downloads/";

// The signed URL never reaches a chat client. Any bad token is a flat 404: the route is no oracle.
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
  if (!resolved) return jsonError(404, "Not found");

  const workspace = await ctx.runQuery(internal.workspace.configs.getById, {
    accountId: resolved.accountId,
    workspaceId: resolved.workspaceId,
  });
  if (!workspace) return jsonError(404, "Not found");

  let url: string;
  try {
    url = await ctx.runAction(internal.aws.workspaceFiles.downloadUrl, {
      accountId: resolved.accountId,
      workspaceId: resolved.workspaceId,
      storage: normalizeWorkspaceConfig(workspace.config).storage,
      path: resolved.path,
    });
  } catch {
    return jsonError(404, "Not found");
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

// Answers a path, not a URL: behind the gateway, which strips Host, we cannot know our origin.
export async function handleWorkspaceDownloadLinkRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  workspaceId: string,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const workspace = await ctx.runQuery(internal.workspace.configs.getById, {
    accountId: accountId,
    workspaceId: workspaceId,
  });
  if (!workspace) return jsonError(404, "Workspace not found");

  const body = (await req.json()) as {
    path?: unknown;
    expiresInSeconds?: unknown;
  };
  if (typeof body.path !== "string") return jsonError(400, "path is required");
  const ttl = parseDownloadTtlSeconds(body.expiresInSeconds);
  if (ttl instanceof Response) return ttl;
  const path = normalizeFilePath(body.path);

  // Presign now so a link is never handed out for a file that would 404 when followed.
  try {
    await ctx.runAction(internal.aws.workspaceFiles.downloadUrl, {
      accountId: accountId,
      workspaceId: workspace._id,
      storage: normalizeWorkspaceConfig(workspace.config).storage,
      path: path,
    });
  } catch {
    return jsonError(404, "Workspace file not found");
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

export async function handleWorkspaceFilesRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  workspaceId: string,
): Promise<Response> {
  const workspace = await ctx.runQuery(internal.workspace.configs.getById, {
    accountId: accountId,
    workspaceId: workspaceId,
  });
  if (!workspace) return jsonError(404, "Workspace not found");
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
      return jsonError(400, "path and contentBase64 are required");
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
      return jsonError(400, "path and newPath are required");
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
      return jsonError(400, "path is required");
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

export function parseDownloadRoute(pathname: string): string | null {
  const match = pathname.match(/^\/v1\/downloads\/([A-Za-z0-9_-]{16,128})$/);

  return match?.[1] ?? null;
}

// base64url only: chat clients decode a `+` in a link back into a space.
function generateDownloadToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseDownloadTtlSeconds(value: unknown): number | Response {
  if (value === undefined) return DEFAULT_DOWNLOAD_TOKEN_TTL_SECONDS;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_DOWNLOAD_TOKEN_TTL_SECONDS
  ) {
    return jsonError(
      400,
      `expiresInSeconds must be an integer between 1 and ${MAX_DOWNLOAD_TOKEN_TTL_SECONDS}`,
    );
  }

  return value;
}
