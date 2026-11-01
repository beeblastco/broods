import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalQuery,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { mcpDoc } from "./account/mcp";
import { mcpFields } from "./schema";
import { storeMcpBundle, type StoredMcpBundle } from "./model/bundles";
import {
  ACCOUNT_ENV_PLACEHOLDER_PATTERN,
  CREDENTIAL_HEADER_VALUE_PATTERN,
} from "./model/envRefs";
import { requireActiveAccount } from "./model/activeAccount";
import { REDACTED_SECRET_VALUE } from "./model/configValues";
import { normalizeMcpInput, type McpInput } from "./model/mcp";
import { stripUndefined } from "./model/objects";
import { getOwnedStage, getProjectStage } from "./model/ownership/stage";
import { getProjectForRole } from "./model/ownership/project";
import { serviceEnv, serviceHeaders } from "./model/serviceBridge";

const scopeArgs = {
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  nodeId: v.string(),
};

interface NodeContext {
  accountId: Id<"accounts">;
  existing: Doc<"mcp"> | null;
}

interface NodeScope {
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  nodeId: string;
}

interface ResolvedConnection {
  transport: "http" | "hosted";
  url?: string;
  headers?: Record<string, string>;
  bundleStorageKey?: string;
  sha256?: string;
  // Lets the save-time probe run on the runtime the row will use.
  workersCompatible?: boolean;
}

interface StageServer {
  nodeId: string;
  name: string;
  transport: Doc<"mcp">["transport"];
  sandbox: string | null;
  disabled: boolean;
}

export const callTool = action({
  args: {
    ...scopeArgs,
    toolName: v.string(),
    input: v.optional(v.any()),
  },
  returns: v.object({ result: v.any(), durationMs: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ result: unknown; durationMs: number }> => {
    // Admin only: a tool call has side effects in the tenant's systems.
    await ctx.runQuery(internal.mcp.nodeContext, {
      projectId: args.projectId,
      stageId: args.stageId,
      nodeId: args.nodeId,
      requiredRole: "admin",
    });
    const server = await requireServer(ctx, args);
    const response = await coreMcpRpc(server.accountId, {
      serverId: server._id,
      method: "tools/call",
      toolName: args.toolName,
      args: args.input ?? {},
    });

    return {
      result: response.result,
      durationMs:
        typeof response.durationMs === "number" ? response.durationMs : 0,
    };
  },
});

export const getByNode = query({
  args: scopeArgs,
  returns: v.union(v.null(), mcpDoc),
  handler: async (
    ctx,
    { projectId, stageId, nodeId },
  ): Promise<Doc<"mcp"> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Soft misses: a deleted project or stage yields null instead of crashing the canvas.
    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return null;
    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    const server = await activeServerByNode(ctx, stageId, nodeId);
    if (
      !server?.headers ||
      (await getProjectForRole(ctx, authUser.id, projectId, "admin"))
    ) {
      return server;
    }

    // Members see ${NAME} refs, never values; only admins save, so a mask never reaches a row.
    return {
      ...server,
      headers: Object.fromEntries(
        Object.entries(server.headers).map(([name, value]) => [
          name,
          CREDENTIAL_HEADER_VALUE_PATTERN.test(value)
            ? value
            : REDACTED_SECRET_VALUE,
        ]),
      ),
    };
  },
});

export const listByStage = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.optional(v.id("stages")),
  },
  returns: v.array(
    v.object({
      nodeId: v.string(),
      name: v.string(),
      transport: v.union(
        v.literal("http"),
        v.literal("hosted"),
        v.literal("machine"),
      ),
      sandbox: v.union(v.string(), v.null()),
      disabled: v.boolean(),
    }),
  ),
  handler: async (ctx, { projectId, stageId }): Promise<StageServer[]> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const stage = await getProjectStage(ctx, user.id, projectId, stageId);
    if (!stage) return [];

    const servers = await ctx.db
      .query("mcp")
      .withIndex("by_stageId_and_status_and_name", (q) =>
        q.eq("stageId", stage._id).eq("status", "active"),
      )
      .collect();

    return servers.flatMap((server) =>
      server.nodeId
        ? [
            {
              nodeId: server.nodeId,
              name: server.name,
              transport: server.transport,
              sandbox: server.sandbox ?? null,
              disabled: server.disabled === true,
            },
          ]
        : [],
    );
  },
});

export const listTools = action({
  args: scopeArgs,
  returns: v.array(v.any()),
  handler: async (ctx, args): Promise<unknown[]> => {
    const server = await requireServer(ctx, args);

    return await coreMcpListTools(server.accountId, { serverId: server._id });
  },
});

export const nodeContext = internalQuery({
  args: {
    ...scopeArgs,
    requiredRole: v.optional(
      v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    ),
  },
  returns: v.object({
    accountId: v.id("accounts"),
    existing: v.union(v.null(), mcpDoc),
  }),
  handler: async (
    ctx,
    { projectId, stageId, nodeId, requiredRole },
  ): Promise<NodeContext> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(
      ctx,
      authUser.id,
      projectId,
      requiredRole,
    );
    if (!project) {
      throw new Error(
        requiredRole
          ? "MCP servers can only be changed or called by an org admin."
          : "Project not found.",
      );
    }
    const stage = await getOwnedStage(ctx, authUser.id, stageId, requiredRole);
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId))
      .first();
    if (!account) throw new Error("Account not found for project org");
    await requireActiveAccount(ctx, account._id);

    return {
      accountId: account._id,
      existing: await activeServerByNode(ctx, stageId, nodeId),
    };
  },
});

export const removeForNode = action({
  args: scopeArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const context: NodeContext = await ctx.runQuery(internal.mcp.nodeContext, {
      projectId: args.projectId,
      stageId: args.stageId,
      nodeId: args.nodeId,
      requiredRole: "admin",
    });
    if (context.existing) {
      await ctx.runMutation(internal.account.mcp.remove, {
        accountId: context.accountId,
        serverId: context.existing._id,
      });
    }

    return null;
  },
});

export const saveForNode = action({
  args: {
    ...scopeArgs,
    nodeLabel: v.string(),
    url: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
    bundle: v.optional(v.string()),
    sourceCode: v.optional(v.string()),
    description: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
    runtime: mcpFields.runtime,
  },
  returns: v.object({
    serverId: v.id("mcp"),
    verified: v.boolean(),
    tools: v.array(v.any()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ serverId: Id<"mcp">; verified: boolean; tools: unknown[] }> => {
    const context: NodeContext = await ctx.runQuery(internal.mcp.nodeContext, {
      projectId: args.projectId,
      stageId: args.stageId,
      nodeId: args.nodeId,
      requiredRole: "admin",
    });

    const input = await normalizeMcpInput(
      stripUndefined({
        name: mcpNameFromLabel(args.nodeLabel),
        url: args.url,
        bundle: args.bundle,
        headers: args.headers,
        description: args.description,
        disabled: args.disabled,
        runtime: args.runtime,
      }),
      { requireConnection: context.existing === null },
    );
    const touchesConnection =
      context.existing === null ||
      args.url !== undefined ||
      args.bundle !== undefined ||
      args.headers !== undefined;
    if (context.existing?.transport === "machine") {
      if (touchesConnection) {
        throw new Error(
          "A server on a machine is defined in code: defineMcp({ sandbox }) and broods machine --mcp on that computer.",
        );
      }
      const serverId = await writeRow(ctx, context, args, input, null);

      return { serverId: serverId, verified: true, tools: [] };
    }
    const connection = await resolveConnection(ctx, context, input);
    // A metadata-only edit skips the probe, so an unreachable server can still be disabled.
    const probe = touchesConnection
      ? await probeServer(context.accountId, input.name!, connection)
      : { verified: true, tools: [] };
    const serverId = await writeRow(ctx, context, args, input, connection);

    return { serverId: serverId, verified: probe.verified, tools: probe.tools };
  },
});

async function activeServerByNode(
  ctx: QueryCtx,
  stageId: Id<"stages">,
  nodeId: string,
): Promise<Doc<"mcp"> | null> {
  // A canvas delete then redeploy leaves a soft-deleted row beside the live one.
  const servers = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_nodeId", (q) =>
      q.eq("stageId", stageId).eq("nodeId", nodeId),
    )
    .collect();

  return servers.find((server) => server.status === "active") ?? null;
}

async function coreMcpListTools(
  accountId: string,
  target: { serverId?: string; probe?: Record<string, unknown> },
): Promise<unknown[]> {
  const response = await coreMcpRpc(accountId, {
    ...target,
    method: "tools/list",
  });

  return Array.isArray(response.tools) ? response.tools : [];
}

async function coreMcpRpc(
  accountId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { url, secret } = serviceEnv();
  const response = await fetch(`${url}/v1/mcp-service/rpc`, {
    method: "POST",
    headers: serviceHeaders(accountId, secret),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON errors fall through to the status check below.
  }
  if (!response.ok) {
    throw new Error(
      typeof parsed.error === "string"
        ? parsed.error
        : `MCP request failed with status ${response.status}`,
    );
  }

  return parsed;
}

function mcpNameFromLabel(label: string): string {
  const name = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 32);
  if (!name) {
    throw new Error(
      "Name the node with letters, digits or hyphens (starting with a letter) before saving.",
    );
  }

  return name;
}

// ${NAME} headers resolve only inside an agent config, so those rows save unverified.
async function probeServer(
  accountId: Id<"accounts">,
  name: string,
  connection: ResolvedConnection,
): Promise<{ verified: boolean; tools: unknown[] }> {
  const probeable = !Object.values(connection.headers ?? {}).some((value) =>
    ACCOUNT_ENV_PLACEHOLDER_PATTERN.test(value),
  );
  if (!probeable) return { verified: false, tools: [] };

  const tools = await coreMcpListTools(accountId, {
    probe: stripUndefined({ name: name, ...connection }),
  });

  return { verified: true, tools: tools };
}

async function requireServer(
  ctx: ActionCtx,
  args: NodeScope,
): Promise<Doc<"mcp">> {
  const server = await ctx.runQuery(api.mcp.getByNode, {
    projectId: args.projectId,
    stageId: args.stageId,
    nodeId: args.nodeId,
  });
  if (!server) throw new Error("MCP server not found. Save the node first.");
  if (server.disabled === true) throw new Error("MCP server is disabled.");

  return server;
}

async function resolveConnection(
  ctx: ActionCtx,
  context: NodeContext,
  input: McpInput,
): Promise<ResolvedConnection> {
  const existing = context.existing;
  const transport: ResolvedConnection["transport"] =
    (input.transport ?? existing?.transport) === "hosted" ? "hosted" : "http";
  if (transport === "http") {
    const url = input.url ?? existing?.url;
    if (!url) throw new Error("Provide the server url before saving it.");

    return stripUndefined({
      transport: transport,
      url: url,
      headers: input.headers ?? existing?.headers,
    });
  }

  const stored = await storeBundle(ctx, context, input);
  if (!stored) {
    throw new Error("Write the server code before saving it.");
  }

  return stripUndefined({
    transport: transport,
    ...stored,
    headers: input.headers ?? existing?.headers,
  });
}

async function storeBundle(
  ctx: ActionCtx,
  context: NodeContext,
  input: McpInput,
): Promise<StoredMcpBundle | null> {
  const stored = await storeMcpBundle(
    ctx,
    context.accountId,
    input,
    context.existing,
  );
  if (stored !== undefined) return stored;
  const existing = context.existing;
  if (existing?.bundleStorageKey && existing.sha256) {
    return {
      bundleStorageKey: existing.bundleStorageKey,
      sha256: existing.sha256,
      workersCompatible: existing.workersCompatible,
    };
  }

  return null;
}

async function writeRow(
  ctx: ActionCtx,
  context: NodeContext,
  args: NodeScope & { nodeLabel: string; sourceCode?: string },
  input: McpInput,
  connection: ResolvedConnection | null,
): Promise<Id<"mcp">> {
  const sourceCode =
    connection?.transport === "hosted" ? args.sourceCode : undefined;
  const shared = stripUndefined({
    ...connection,
    name: input.name,
    description: input.description,
    disabled: input.disabled,
    runtime: input.runtime,
    sourceCode: sourceCode,
  });
  if (context.existing) {
    await ctx.runMutation(internal.account.mcp.update, {
      accountId: context.accountId,
      serverId: context.existing._id,
      ...shared,
    });

    return context.existing._id;
  }

  return await ctx.runMutation(internal.account.mcp.create, {
    accountId: context.accountId,
    projectId: args.projectId,
    stageId: args.stageId,
    nodeId: args.nodeId,
    ...shared,
    name: input.name!,
  });
}
