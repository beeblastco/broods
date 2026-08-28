/**
 * Public config-plane HTTP surface: agents, skills, tools, hooks, workspace
 * files, crons, workspaces, sandboxes, policies, and roles served straight
 * from Convex. The gateway forwards these paths here; response shapes match
 * the retired core handlers so the public API contract is unchanged. Auth is
 * the account Bearer secret, or an fp_sts_ role session checked against its
 * role's policy at this funnel. This file is the router; each resource
 * family's handlers live in `config/routes/`.
 */

import { httpAction, type ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { ConfigAuditActor } from "../model/auditEvents";
import { handleAccountRoute, parseAccountRoute } from "./routes/accounts";
import {
  handleAgentChannelDirectoryRoute,
  handleAgentConfigRoute,
} from "./routes/agents";
import { handleChannelRecordRoute } from "./routes/channels";
import { handleCronRoute } from "./routes/crons";
import { handleAccountEnvVarRoute } from "./routes/envVars";
import { handleHookRoute } from "./routes/hooks";
import {
  apiActionForRequest,
  authorize,
  type ApiResource,
  type ApiResourceType,
} from "../model/apiAuthorization";
import { handlePolicyConfigRoute } from "./routes/policies";
import { handleAssumeRoleRoute, handleRoleRoute } from "./routes/roles";
import { handleSandboxConfigRoute } from "./routes/sandboxes";
import {
  auditActorForAuth,
  json,
  requireAccount,
  rolePrincipal,
} from "./routes/shared";
import { handleSkillRoute } from "./routes/skills";
import { handleToolRoute } from "./routes/tools";
import {
  handleDownloadRedeemRoute,
  handleWorkspaceDownloadLinkRoute,
  handleWorkspaceFilesRoute,
  parseDownloadRoute,
} from "./routes/workspaceFiles";
import { handleWorkspaceConfigRoute } from "./routes/workspaces";

/** Resource family each route kind authorizes as, for role sessions. */
const API_RESOURCE_TYPE_BY_ROUTE_KIND: Record<
  Exclude<ConfigRoute, { kind: "roles" }>["kind"],
  ApiResourceType
> = {
  skills: "skills",
  tools: "tools",
  hooks: "hooks",
  workspaceFiles: "workspaces",
  workspaceDownloadLinks: "workspaces",
  crons: "crons",
  workspaces: "workspaces",
  sandboxes: "sandboxes",
  policies: "policies",
  channels: "channels",
  agents: "agents",
  agentChannelDirectory: "agents",
  env: "env",
};

type ConfigRoute =
  | { kind: "skills"; name?: string }
  | { kind: "tools"; toolId?: string }
  | { kind: "hooks"; hookId?: string }
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
  | { kind: "roles"; roleId?: string };

export const handle = httpAction(async (ctx, req) => {
  try {
    // The exchange authenticates its own caller kinds (account secret, CLI
    // token, runtime key), so it runs before the shared bearer funnel.
    if (new URL(req.url).pathname === "/v1/account/assume-role") {
      return await handleAssumeRoleRoute(ctx, req);
    }

    const accountRoute = parseAccountRoute(new URL(req.url).pathname);
    if (accountRoute) return await handleAccountRoute(ctx, req, accountRoute);

    // Redeeming a download token carries no Authorization header: the token in
    // the path is the whole credential, so it runs before requireAccount.
    const downloadToken = parseDownloadRoute(new URL(req.url).pathname);
    if (downloadToken)
      return await handleDownloadRedeemRoute(ctx, req, downloadToken);

    const accountAuth = await requireAccount(ctx, req);
    if (accountAuth instanceof Response) return accountAuth;
    const account = accountAuth.account;
    const actor = auditActorForAuth(accountAuth);
    const route = parseRoute(new URL(req.url).pathname);
    if (!route) return json({ error: "Not found" }, 404);

    // Role management stays with the master credential: a session that could
    // edit roles could grant itself anything.
    if (route.kind === "roles") {
      if (accountAuth.kind !== "account") {
        return json(
          { error: "Role management requires the account secret" },
          403,
        );
      }

      return await handleRoleRoute(ctx, req, account._id, actor, route.roleId);
    }

    // The decision funnel for role sessions: every other kind keeps its
    // current behavior, a role must be allowed by its own policy.
    if (accountAuth.kind === "role") {
      const resource = apiResourceForRoute(route);
      const action = apiActionForRequest(req.method, resource.type);
      const decision = authorize(rolePrincipal(accountAuth), action, resource);
      if (!decision.allow) {
        return json({ error: `Role is not allowed to ${action}` }, 403);
      }
    }

    return await dispatchResourceRoute(ctx, req, account._id, actor, route);
  } catch (err) {
    if (isClientInputError(err)) {
      return json({ error: err.message }, clientErrorStatus(err));
    }
    console.error("config HTTP request failed", err);

    return json({ error: "Internal server error" }, 500);
  }
});

/**
 * Map a parsed route onto the config-plane resource it addresses, for the
 * role-session `authorize()` check. Workspace subresources authorize as their
 * workspace; the agent channel directory authorizes as its agent.
 * @param route parsed config route (role management is handled before this)
 * @returns the resource the request addresses
 */
function apiResourceForRoute(
  route: Exclude<ConfigRoute, { kind: "roles" }>,
): ApiResource {
  const id = apiResourceIdForRoute(route);

  return {
    type: API_RESOURCE_TYPE_BY_ROUTE_KIND[route.kind],
    ...(id !== undefined ? { id: id } : {}),
  };
}

/** The item id a parsed route addresses, when it addresses one. */
function apiResourceIdForRoute(
  route: Exclude<ConfigRoute, { kind: "roles" }>,
): string | undefined {
  switch (route.kind) {
    case "skills":
    case "env":
      return route.name;
    case "tools":
      return route.toolId;
    case "hooks":
      return route.hookId;
    case "workspaceFiles":
    case "workspaceDownloadLinks":
    case "workspaces":
      return route.workspaceId;
    case "crons":
      return route.cronId;
    case "sandboxes":
      return route.sandboxId;
    case "policies":
      return route.policyId;
    case "channels":
      return route.channelId;
    case "agents":
    case "agentChannelDirectory":
      return route.agentId;
  }
}

/**
 * Dispatch an authorized request to its resource family's handler.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @param accountId authenticated account
 * @param actor audit actor
 * @param route parsed config route (role management is handled before this)
 * @returns HTTP response
 */
async function dispatchResourceRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  route: Exclude<ConfigRoute, { kind: "roles" }>,
): Promise<Response> {
  switch (route.kind) {
    case "skills":
      return await handleSkillRoute(ctx, req, accountId, actor, route.name);
    case "tools":
      return await handleToolRoute(ctx, req, accountId, actor, route.toolId);
    case "hooks":
      return await handleHookRoute(ctx, req, accountId, actor, route.hookId);
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
      );
    case "agents":
      return await handleAgentConfigRoute(
        ctx,
        req,
        accountId,
        actor,
        route.agentId,
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
  }
}

/**
 * Map a client-input error to its HTTP status. Core returned 401 for
 * foreign-account skill paths and 404 for dangling agent references
 * (errorResponseForError); everything else is a plain 400.
 * @param error the recognized client-input error
 * @returns the HTTP status core used for this message
 */
function clientErrorStatus(error: Error): number {
  if (error.message.startsWith("Skill path belongs to another account:"))
    return 401;
  if (error.message.startsWith("Agent name already exists:")) return 409;
  if (
    error.message.startsWith("Skill not found:") ||
    error.message.startsWith("Subagent not found:") ||
    error.message.startsWith("Agent policy not found:")
  ) {
    return 404;
  }

  return 400;
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
    "Invalid request JSON:",
    "Invalid skill path:",
    "Skill path belongs",
    "Skill not found:",
    "Subagent not found:",
    "Agent policy not found:",
    "Agent name already exists:",
    "SKILL.md ",
    "GitHub skill URL ",
    "GitHub archive ",
    "url must ",
    "path ",
    "path and ",
    "contentBase64 ",
    "config must",
    "config.",
    "e2b ",
    "Invalid workspace path",
    "Invalid workspace file path",
    "Invalid destination path",
    "Workspace uploads ",
    "Workspace file not found",
    "Workspace path not found",
    "name must",
    "username must",
    "agentId must",
    "Agent config ",
    "description must",
    "conversationKey must",
    "scheduleExpression must",
    "timezone ",
    "status must",
    "policy ",
    "Policy document",
    "Policy rule",
    "Policy does not belong",
    "roleId must",
    "ttlSeconds must",
    "projectId and stageId",
    "projectId must",
    "stageId must",
    "Role does not belong",
    "Sandbox config does not belong",
    "Workspace config does not belong",
    "events must",
    "Provide exactly one of",
    "limit must",
    "Cron job agentId ",
    "unknown env vars:",
    "env name must",
    "env value must",
  ].some((prefix) => error.message.startsWith(prefix));
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
      ...(skills[1] ? { name: decodeURIComponent(skills[1]) } : {}),
    };

  const tools = pathname.match(/^\/v1\/tools(?:\/([^/]+))?$/);
  if (tools)
    return {
      kind: "tools",
      ...(tools[1] ? { toolId: decodeURIComponent(tools[1]) } : {}),
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
 * Parse a config-plane pathname into its route parts.
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
