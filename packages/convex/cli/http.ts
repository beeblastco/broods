import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { bearerToken, runTokenRefusal } from "../config/routes/shared";
import {
  ACCOUNT_KEY_PREFIX,
  PROJECT_KEY_PREFIX,
  sha256Hex,
} from "../model/accountSecrets";
import { CLI_TOKEN_PREFIX } from "./auth";
import {
  handleEnvListRoute,
  handleEnvRoute,
  handleLogsRoute,
  handleManifestRoute,
  handleMcpBundleUploadRoute,
  handleResourceDeleteRoute,
  handleRuntimeKeyRoute,
  handleUserTokenSecretRoute,
  type CliAuth,
  type RouteParts,
} from "./httpRoutes";
import { clientErrorResponse } from "../model/clientError";
import { jsonError } from "../model/httpJson";

export const handle = httpAction(async (ctx, req): Promise<Response> => {
  try {
    const refusal = runTokenRefusal(req);
    if (refusal) return refusal;
    const token = bearerToken(req);
    if (!token) {
      return jsonError(401, "Authorization Bearer token is required");
    }

    const route = parseRoute(new URL(req.url).pathname);
    if (!route) return jsonError(404, "Not found");

    const authResult = await resolveCliRequestAuth(ctx, token, route);
    if (!authResult)
      return jsonError(401, "Invalid or out-of-scope project key");

    switch (route.kind) {
      case "manifest":
        return await handleManifestRoute(ctx, req, route, authResult);
      case "mcpBundleUpload":
        return await handleMcpBundleUploadRoute(ctx, req, authResult);
      case "logs":
        return handleLogsRoute(req);
      case "runtimeKey":
        return await handleRuntimeKeyRoute(ctx, req, route, authResult);
      case "userTokenSecret":
        return await handleUserTokenSecretRoute(ctx, req, route, authResult);
      case "envList":
        return await handleEnvListRoute(ctx, req, route, authResult);
      case "env":
        return await handleEnvRoute(ctx, req, route, authResult);
      case "resource":
        return await handleResourceDeleteRoute(ctx, req, route, authResult);
    }
  } catch (error) {
    // Mostly the caller's manifest failing validation: hand the reason back to `broods dev`.
    const clientError = clientErrorResponse(error);
    if (clientError) return clientError;
    if (error instanceof SyntaxError || error instanceof URIError) {
      return jsonError(400, "Request body or path is invalid");
    }
    console.error("CLI request failed", error);

    return jsonError(500, "CLI request failed");
  }
});

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
  if (rest.length === 1 && rest[0] === "mcp-bundle-uploads") {
    return { kind: "mcpBundleUpload", project: project, stage: stage };
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
  if (rest.length === 1 && rest[0] === "user-token-secret") {
    return { kind: "userTokenSecret", project: project, stage: stage };
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

async function resolveCliRequestAuth(
  ctx: ActionCtx,
  token: string,
  route: RouteParts,
): Promise<CliAuth | null> {
  const tokenHash = await sha256Hex(token);

  if (token.startsWith(CLI_TOKEN_PREFIX)) {
    const cliResolved = await ctx.runMutation(
      internal.cli.auth.resolveCliToken,
      { tokenHash: tokenHash },
    );

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

  const keyKind = token.startsWith(ACCOUNT_KEY_PREFIX)
    ? "account"
    : token.startsWith(PROJECT_KEY_PREFIX)
      ? "project"
      : null;
  if (!keyKind) return null;

  return await ctx.runQuery(internal.cli.sync.resolveCliAuth, {
    tokenHash: tokenHash,
    keyKind: keyKind,
    project: route.project,
    stage: route.stage,
  });
}

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
