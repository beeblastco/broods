/**
 * Public config-plane HTTP surface: agents, skills, mcp, hooks, workspace
 * files, crons, workspaces, sandboxes, policies, and roles served straight
 * from Convex. Traefik routes these paths here (`apps/edge`); response shapes match
 * the retired core handlers so the public API contract is unchanged. Auth is
 * the account key, or a bsts_ role session checked against its
 * role's policy at this funnel. This file is the router; each resource
 * family's handlers live in `config/routes/`.
 */

import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  roleDenial,
  rolePrincipal,
  type ApiPrincipal,
  type ApiResource,
  type RolePrincipal,
} from "../model/apiAuthorization";
import type { AuditActor } from "../model/auditEvents";
import { CLIENT_ERROR_STATUS, clientErrorData } from "../model/clientError";
import { POLICY_STILL_REFERENCED } from "../model/policyReferences";
import {
  STAGE_SCOPED_RESOURCE_TYPES,
  type StageScopedResourceType,
} from "../model/projectScope";
import { resolveRequestId, withRequestId } from "../model/requestId";
import { handleAccountRoute, parseAccountRoute } from "./routes/accounts";
import {
  handleAuditRoute,
  parseAuditRoute,
  type AuditLeaf,
} from "./routes/audit";
import {
  handleAgentChannelDirectoryRoute,
  handleAgentConfigRoute,
} from "./routes/agents";
import { handleChannelRecordRoute } from "./routes/channels";
import {
  handleConnectionsRoute,
  parseConnectionsPath,
} from "./routes/connections";
import { handleCronRoute } from "./routes/crons";
import { handleAccountEnvVarRoute } from "./routes/envVars";
import { handleHookRoute } from "./routes/hooks";
import { handleMcpRoute, handleMcpUploadsRoute } from "./routes/mcp";
import { handlePolicyConfigRoute } from "./routes/policies";
import { handleAssumeRoleRoute, handleRoleRoute } from "./routes/roles";
import { handleSandboxConfigRoute } from "./routes/sandboxes";
import {
  auditActorForAuth,
  jsonError,
  requireAccount,
  runTokenRefusal,
} from "./routes/shared";
import { handleSkillRoute } from "./routes/skills";
import {
  handleDownloadRedeemRoute,
  handleWorkspaceDownloadLinkRoute,
  handleWorkspaceFilesRoute,
  parseDownloadRoute,
} from "./routes/workspaceFiles";
import { handleWorkspaceConfigRoute } from "./routes/workspaces";

type ConfigRoute =
  | { kind: "skills"; skillName?: string }
  | { kind: "hooks"; hookId?: string }
  | { kind: "mcp"; serverId?: string }
  | { kind: "mcpBundleUpload" }
  | { kind: "workspaceFiles"; workspaceId: string }
  | { kind: "workspaceDownloadLinks"; workspaceId: string }
  | { kind: "crons"; cronId?: string; runs: boolean }
  | { kind: "workspaces"; workspaceId?: string }
  | { kind: "sandboxes"; sandboxId?: string }
  | { kind: "policies"; policyId?: string }
  | { kind: "channels"; channelId?: string }
  | { kind: "agents"; agentId?: string }
  | { kind: "agentChannelDirectory"; agentId: string; channelType: string }
  | { kind: "env"; name?: string }
  | { kind: "audit"; leaf: AuditLeaf }
  | { kind: "roles"; roleId?: string };

type ResourceRoute = Exclude<ConfigRoute, { kind: "roles" }>;

export const handle = httpAction(async (ctx, req): Promise<Response> =>
  withRequestId(
    await handleConfigRequest(ctx, req),
    resolveRequestId(req.headers.get("x-request-id")),
  ),
);

async function handleConfigRequest(
  ctx: ActionCtx,
  req: Request,
): Promise<Response> {
  // Only a role is scoped below the account, so every other caller already
  // reads the resources a policy refusal would name.
  let readsPolicyReferences = true;
  try {
    const pathname = new URL(req.url).pathname;

    const refusal = runTokenRefusal(req);
    if (refusal) return refusal;

    // The exchange authenticates its own caller kinds (account key, CLI
    // token, runtime key), so it runs before the shared bearer funnel.
    if (pathname === "/v1/account/assume-role") {
      return await handleAssumeRoleRoute(ctx, req);
    }

    // Authenticates itself too: account key or CLI login, never a role session.
    const connectionsPath = parseConnectionsPath(pathname);
    if (connectionsPath) {
      return await handleConnectionsRoute(ctx, req, connectionsPath);
    }

    const accountRoute = parseAccountRoute(pathname);
    if (accountRoute) return await handleAccountRoute(ctx, req, accountRoute);

    // Redeeming a download token carries no Authorization header: the token in
    // the path is the whole credential, so it runs before requireAccount.
    const downloadToken = parseDownloadRoute(pathname);
    if (downloadToken)
      return await handleDownloadRedeemRoute(ctx, req, downloadToken);

    const accountAuth = await requireAccount(ctx, req);
    if (accountAuth instanceof Response) return accountAuth;
    const account = accountAuth.account;
    const actor = auditActorForAuth(accountAuth);
    const route = parseRoute(pathname);
    if (!route) return jsonError(404, "Not found");

    // Role management stays with the master credential: a session that could
    // edit roles could grant itself anything.
    if (route.kind === "roles") {
      if (accountAuth.kind !== "account") {
        return jsonError(403, "Role management requires the account key");
      }

      return await handleRoleRoute(ctx, req, account._id, actor, route.roleId);
    }

    // Carried to the routes whose writes must not point at another stage.
    let role: RolePrincipal | undefined;
    if (accountAuth.kind === "role") {
      role = accountAuth.role;
      const principal = rolePrincipal(accountAuth.role);
      readsPolicyReferences =
        roleDenial(principal, "GET", { type: "agents" }) === null &&
        roleDenial(principal, "GET", { type: "channels" }) === null;
      const denial = roleDenial(
        principal,
        req.method,
        await withStageScope(
          ctx,
          account._id,
          principal,
          apiResourceForRoute(route),
        ),
      );
      if (denial) return jsonError(403, denial);
    }

    return await dispatchResourceRoute(
      ctx,
      req,
      account._id,
      actor,
      route,
      role,
    );
  } catch (err) {
    const clientError = clientErrorData(err);
    if (clientError) {
      // The policy refusal names the agents and channel records that still
      // list the policy. A role holding only policies:write may not read
      // either, so it gets the refusal without the names.
      const message =
        !readsPolicyReferences &&
        clientError.message.startsWith(POLICY_STILL_REFERENCED)
          ? `${POLICY_STILL_REFERENCED} an agent or a channel record still lists this policy. Detach it before deleting it.`
          : clientError.message;

      return jsonError(CLIENT_ERROR_STATUS[clientError.code], message);
    }
    if (err instanceof SyntaxError) return jsonError(400, err.message);
    console.error("config HTTP request failed", err);

    return jsonError(500, "Internal server error");
  }
}

/** Build an `authorize()` resource, dropping an absent id. */
function apiResource(
  type: ApiResource["type"],
  id: string | undefined,
): ApiResource {
  return { type: type, ...(id !== undefined ? { id: id } : {}) };
}

/**
 * Map a parsed route onto the config-plane resource it addresses, for the
 * role-session `authorize()` check. Workspace subresources authorize as their
 * workspace; the agent channel directory authorizes as its agent.
 */
function apiResourceForRoute(route: ResourceRoute): ApiResource {
  switch (route.kind) {
    case "skills":
      return apiResource("skills", route.skillName);
    case "hooks":
      return apiResource("hooks", route.hookId);
    case "mcp":
      return apiResource("mcp", route.serverId);
    // Minting an upload URL authorizes like a collection-level MCP write, not
    // like an operation on a server named "uploads".
    case "mcpBundleUpload":
      return apiResource("mcp", undefined);
    case "workspaceFiles":
    case "workspaceDownloadLinks":
    case "workspaces":
      return apiResource("workspaces", route.workspaceId);
    case "crons":
      return apiResource("crons", route.cronId);
    case "sandboxes":
      return apiResource("sandboxes", route.sandboxId);
    case "policies":
      return apiResource("policies", route.policyId);
    case "channels":
      return apiResource("channels", route.channelId);
    case "agents":
    case "agentChannelDirectory":
      return apiResource("agents", route.agentId);
    case "env":
      return apiResource("env", route.name);
    case "audit":
      return apiResource("audit", undefined);
  }
}

/**
 * Attach the addressed resource's stage when the role is pinned to one, so
 * `authorize()` can hold the request to the pin. Collections and
 * account-scoped resources stay unscoped, which a pinned role is refused.
 */
async function withStageScope(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  principal: ApiPrincipal,
  resource: ApiResource,
): Promise<ApiResource> {
  if (principal.projectId === undefined && principal.stageId === undefined) {
    return resource;
  }
  if (resource.id === undefined || !isStageScoped(resource.type)) {
    return resource;
  }
  const scope = await ctx.runQuery(internal.account.roles.resourceScope, {
    accountId: accountId,
    type: resource.type,
    id: resource.id,
  });

  return scope ? { ...resource, ...scope } : resource;
}

function isStageScoped(
  type: ApiResource["type"],
): type is StageScopedResourceType {
  return (STAGE_SCOPED_RESOURCE_TYPES as readonly string[]).includes(type);
}

async function dispatchResourceRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  route: ResourceRoute,
  role: RolePrincipal | undefined,
): Promise<Response> {
  switch (route.kind) {
    case "skills":
      return await handleSkillRoute(
        ctx,
        req,
        accountId,
        actor,
        route.skillName,
      );
    case "hooks":
      return await handleHookRoute(ctx, req, accountId, actor, route.hookId);
    case "mcp":
      return await handleMcpRoute(ctx, req, accountId, actor, route.serverId);
    case "mcpBundleUpload":
      return await handleMcpUploadsRoute(ctx, req, accountId);
    case "workspaceFiles":
      return await handleWorkspaceFilesRoute(
        ctx,
        req,
        accountId,
        actor,
        route.workspaceId,
      );
    case "workspaceDownloadLinks":
      return await handleWorkspaceDownloadLinkRoute(
        ctx,
        req,
        accountId,
        actor,
        route.workspaceId,
      );
    case "crons":
      return await handleCronRoute(
        ctx,
        req,
        accountId,
        actor,
        route.cronId,
        route.runs,
        role,
      );
    case "workspaces":
      return await handleWorkspaceConfigRoute(
        ctx,
        req,
        accountId,
        actor,
        route.workspaceId,
      );
    case "sandboxes":
      return await handleSandboxConfigRoute(
        ctx,
        req,
        accountId,
        actor,
        route.sandboxId,
      );
    case "policies":
      return await handlePolicyConfigRoute(
        ctx,
        req,
        accountId,
        actor,
        route.policyId,
      );
    case "channels":
      return await handleChannelRecordRoute(
        ctx,
        req,
        accountId,
        actor,
        route.channelId,
        role,
      );
    case "agents":
      return await handleAgentConfigRoute(
        ctx,
        req,
        accountId,
        actor,
        route.agentId,
        role,
      );
    case "agentChannelDirectory":
      return await handleAgentChannelDirectoryRoute(
        ctx,
        req,
        accountId,
        route.agentId,
        route.channelType,
      );
    case "env":
      return await handleAccountEnvVarRoute(
        ctx,
        req,
        accountId,
        actor,
        route.name,
      );
    case "audit":
      return await handleAuditRoute(ctx, req, accountId, actor, route.leaf);
  }
}

/** Match `/v1/agents/{id}/channels/{type}/directory` and `/v1/agents[/{id}]`. */
function parseAgentRoute(pathname: string): ConfigRoute | null {
  const channelDirectory = pathname.match(
    /^\/v1\/agents\/([^/]+)\/channels\/([^/]+)\/directory$/,
  );
  if (channelDirectory?.[1] && channelDirectory[2]) {
    return {
      kind: "agentChannelDirectory",
      agentId: decodeURIComponent(channelDirectory[1]),
      channelType: decodeURIComponent(channelDirectory[2]),
    };
  }

  const agents = pathname.match(/^\/v1\/agents(?:\/([^/]+))?$/);
  if (agents)
    return {
      kind: "agents",
      ...(agents[1] ? { agentId: decodeURIComponent(agents[1]) } : {}),
    };

  return null;
}

/** Match the flat collection-or-item routes with no nested subresources. */
function parseCollectionRoute(pathname: string): ConfigRoute | null {
  const audit = parseAuditRoute(pathname);
  if (audit) return { kind: "audit", leaf: audit };

  const env = pathname.match(/^\/v1\/env(?:\/([^/]+))?$/);
  if (env)
    return {
      kind: "env",
      ...(env[1] ? { name: decodeURIComponent(env[1]) } : {}),
    };

  const skills = pathname.match(/^\/v1\/skills(?:\/([^/]+))?$/);
  if (skills)
    return {
      kind: "skills",
      ...(skills[1] ? { skillName: decodeURIComponent(skills[1]) } : {}),
    };

  // Before the generic mcp match: `uploads` is a route, not a server id.
  if (pathname === "/v1/mcp/uploads") return { kind: "mcpBundleUpload" };

  const mcp = pathname.match(/^\/v1\/mcp(?:\/([^/]+))?$/);
  if (mcp)
    return {
      kind: "mcp",
      ...(mcp[1] ? { serverId: decodeURIComponent(mcp[1]) } : {}),
    };

  const hooks = pathname.match(/^\/v1\/hooks(?:\/([^/]+))?$/);
  if (hooks)
    return {
      kind: "hooks",
      ...(hooks[1] ? { hookId: decodeURIComponent(hooks[1]) } : {}),
    };

  const sandboxes = pathname.match(/^\/v1\/sandboxes(?:\/([^/]+))?$/);
  if (sandboxes)
    return {
      kind: "sandboxes",
      ...(sandboxes[1] ? { sandboxId: decodeURIComponent(sandboxes[1]) } : {}),
    };

  const policies = pathname.match(/^\/v1\/policies(?:\/([^/]+))?$/);
  if (policies)
    return {
      kind: "policies",
      ...(policies[1] ? { policyId: decodeURIComponent(policies[1]) } : {}),
    };

  const roles = pathname.match(/^\/v1\/roles(?:\/([^/]+))?$/);
  if (roles)
    return {
      kind: "roles",
      ...(roles[1] ? { roleId: decodeURIComponent(roles[1]) } : {}),
    };

  const channels = pathname.match(/^\/v1\/channels(?:\/([^/]+))?$/);
  if (channels)
    return {
      kind: "channels",
      ...(channels[1] ? { channelId: decodeURIComponent(channels[1]) } : {}),
    };

  return null;
}

/** Match `/v1/crons/{id}/runs` and `/v1/crons[/{id}]`. */
function parseCronRoute(pathname: string): ConfigRoute | null {
  const cronRuns = pathname.match(/^\/v1\/crons\/([^/]+)\/runs$/);
  if (cronRuns?.[1])
    return {
      kind: "crons",
      cronId: decodeURIComponent(cronRuns[1]),
      runs: true,
    };

  const crons = pathname.match(/^\/v1\/crons(?:\/([^/]+))?$/);
  if (crons)
    return {
      kind: "crons",
      ...(crons[1] ? { cronId: decodeURIComponent(crons[1]) } : {}),
      runs: false,
    };

  return null;
}

/**
 * @param pathname the request pathname
 * @returns the parsed route, or null when the path is not a config route
 */
function parseRoute(pathname: string): ConfigRoute | null {
  return (
    parseCollectionRoute(pathname) ??
    parseWorkspaceRoute(pathname) ??
    parseAgentRoute(pathname) ??
    parseCronRoute(pathname)
  );
}

/** Match workspace files, download links, and the workspace collection/item. */
function parseWorkspaceRoute(pathname: string): ConfigRoute | null {
  const files = pathname.match(/^\/v1\/workspaces\/([^/]+)\/files$/);
  if (files?.[1])
    return {
      kind: "workspaceFiles",
      workspaceId: decodeURIComponent(files[1]),
    };

  const downloadLinks = pathname.match(
    /^\/v1\/workspaces\/([^/]+)\/download-links$/,
  );
  if (downloadLinks?.[1])
    return {
      kind: "workspaceDownloadLinks",
      workspaceId: decodeURIComponent(downloadLinks[1]),
    };

  const workspaces = pathname.match(/^\/v1\/workspaces(?:\/([^/]+))?$/);
  if (workspaces)
    return {
      kind: "workspaces",
      ...(workspaces[1]
        ? { workspaceId: decodeURIComponent(workspaces[1]) }
        : {}),
    };

  return null;
}
