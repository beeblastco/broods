/**
 * HTTP router for the `broods` CLI.
 *
 * Routes authenticate with the org Bearer secret (or a scoped deploy key /
 * CLI token) and dispatch to the handlers in `cli/httpRoutes.ts`, which
 * delegate writes to `cliSync` so the CLI can sync desired-state manifests
 * without browser auth.
 */

import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { sha256Hex } from "../model/accountSecrets";
import {
  handleEnvListRoute,
  handleEnvRoute,
  handleLogsRoute,
  handleManifestRoute,
  handleResourceDeleteRoute,
  handleRuntimeKeyRoute,
  json,
  type CliAuth,
  type RouteParts,
} from "./httpRoutes";

export const handle = httpAction(async (ctx, req) => {
  try {
    const auth = await bearerAuth(req);
    if (!auth) {
      return json({ error: "Authorization Bearer token is required" }, 401);
    }

    const route = parseRoute(new URL(req.url).pathname);
    if (!route) return json({ error: "Not found" }, 404);

    const authResult = await resolveCliRequestAuth(ctx, auth.secretHash, route);
    if (!authResult)
      return json({ error: "Invalid or out-of-scope deploy token" }, 401);

    switch (route.kind) {
      case "manifest":
        return await handleManifestRoute(ctx, req, route, authResult);
      case "logs":
        return handleLogsRoute(req);
      case "runtimeKey":
        return await handleRuntimeKeyRoute(ctx, req, route, authResult);
      case "envList":
        return await handleEnvListRoute(ctx, req, route, authResult);
      case "env":
        return await handleEnvRoute(ctx, req, route, authResult);
      case "resource":
        return await handleResourceDeleteRoute(ctx, req, route, authResult);
    }
  } catch (error) {
    console.error("CLI request failed", error);
    if (error instanceof SyntaxError || error instanceof URIError) {
      return json({ error: "Request body or path is invalid" }, 400);
    }
    // Most failures here are the caller's own manifest failing validation. Hand
    // the reason back or `broods dev` reports an unactionable 500.
    const detail = error instanceof Error ? error.message : "";

    return json(
      { error: "CLI request failed", ...(detail ? { detail: detail } : {}) },
      500,
    );
  }
});

async function bearerAuth(
  req: Request,
): Promise<{ secretHash: string } | null> {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  return {
    secretHash: await sha256Hex(match[1]),
  };
}

function isResourceKind(
  value: string,
): value is "agent" | "workspace" | "sandbox" | "cron" {
  return (
    value === "agent" ||
    value === "workspace" ||
    value === "sandbox" ||
    value === "cron"
  );
}

function parseRoute(pathname: string): RouteParts | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const scoped = stageRouteParts(parts);
  if (!scoped) return null;
  const { project, stage, rest } = scoped;

  if (rest.length === 1 && rest[0] === "manifest") {
    return { kind: "manifest", project: project, stage: stage };
  }
  if (rest.length === 2 && rest[0] === "env") {
    return { kind: "env", project: project, stage: stage, name: rest[1] };
  }
  if (rest.length === 1 && rest[0] === "logs") {
    return { kind: "logs", project: project, stage: stage };
  }
  if (rest.length === 1 && rest[0] === "runtime-key") {
    return { kind: "runtimeKey", project: project, stage: stage };
  }
  if (rest.length === 1 && rest[0] === "env") {
    return { kind: "envList", project: project, stage: stage };
  }
  if (rest.length === 3 && rest[0] === "resources" && isResourceKind(rest[1])) {
    return {
      kind: "resource",
      project: project,
      stage: stage,
      resourceKind: rest[1],
      name: rest[2],
    };
  }

  return null;
}

/**
 * Resolve the token hash to an account secret hash, enforcing deploy-key scope
 * against the route's project/stage. Cron sync runs natively against the crons
 * table and its registered schedules (agent/crons), so it works for org
 * secrets and scoped deploy keys alike.
 */
async function resolveCliRequestAuth(
  ctx: ActionCtx,
  secretHash: string,
  route: RouteParts,
): Promise<CliAuth | null> {
  const resolved = await ctx.runQuery(internal.cli.sync.resolveCliAuth, {
    tokenHash: secretHash,
    project: route.project,
    stage: route.stage,
  });
  if (resolved) return resolved;

  const cliResolved = await ctx.runMutation(internal.cli.auth.resolveCliToken, {
    tokenHash: secretHash,
  });

  return cliResolved
    ? {
        accountId: cliResolved.accountId,
        secretHash: cliResolved.secretHash,
        scoped: true,
        cliTokenId: cliResolved.cliTokenId,
        cliAuthId: cliResolved.authId,
      }
    : null;
}

/** Match the shared `/v1/account/projects/{project}/stages/{stage}` prefix. */
function stageRouteParts(
  parts: string[],
): { project: string; stage: string; rest: string[] } | null {
  if (
    parts.length < 7 ||
    parts[0] !== "v1" ||
    parts[1] !== "account" ||
    parts[2] !== "projects" ||
    parts[4] !== "stages"
  ) {
    return null;
  }

  return { project: parts[3], stage: parts[5], rest: parts.slice(6) };
}
