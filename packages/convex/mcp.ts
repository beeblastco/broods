/**
 * Dashboard-facing API for MCP servers, backed by the same `mcp` rows the CLI
 * syncs and the runtime connects to. Saves probe the server through core (in
 * the sandboxed Lambda for hosted rows) before the row is written; the tool
 * explorer's list/call verbs ride the same service-auth bridge.
 */

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
import { storeMcpBundle } from "./model/bundles";
import { ACCOUNT_ENV_PLACEHOLDER_PATTERN } from "./model/envRefs";
import { normalizeMcpInput, type McpInput } from "./model/mcp";
import { stripUndefined } from "./model/objects";
import { getOwnedStage } from "./model/ownership/stage";
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

/** The final connection a save resolves to, stored fields only. */
interface ResolvedConnection {
  transport: "http" | "hosted";
  url?: string;
  headers?: Record<string, string>;
  bundleStorageKey?: string;
  sha256?: string;
}

/** Run one tool from the explorer; returns the raw MCP result, isError included. */
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
    // Calling a tool has side effects in the tenant's systems: admin only.
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

/** The MCP server a canvas node owns, or null when it has never been saved. */
export const getByNode = query({
  args: scopeArgs,
  returns: v.union(v.null(), mcpDoc),
  handler: async (ctx, { projectId, stageId, nodeId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Resolve ownership without throwing: a deleted project/stage should
    // yield null for this reactive query rather than crashing the canvas.
    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return null;
    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    return await activeServerByNode(ctx, stageId, nodeId);
  },
});

/** The live tool listing for a node's server, through core's MCP client. */
export const listTools = action({
  args: scopeArgs,
  returns: v.array(v.any()),
  handler: async (ctx, args): Promise<unknown[]> => {
    const server = await requireServer(ctx, args);

    return await coreMcpListTools(server.accountId, { serverId: server._id });
  },
});

/**
 * Ownership check plus the account and existing row `saveForNode` needs.
 * `requiredRole: "admin"` is what every write and direct tool call passes.
 */
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
  handler: async (ctx, { projectId, stageId, nodeId, requiredRole }) => {
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
    if (!project.orgId) throw new Error("Project is not linked to an org");
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId as string))
      .first();
    if (!account) throw new Error("Account not found for project org");

    return {
      accountId: account._id,
      existing: await activeServerByNode(ctx, stageId, nodeId),
    };
  },
});

/** Soft-delete the node's server so a removed canvas node stops registering tools. */
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

/**
 * Save a canvas-authored MCP server: a `url` makes an external row, a
 * `bundle` a hosted one. An action, not a mutation — the bundle reaches S3
 * and passes core's tools/list probe before the row is written. A
 * metadata-only edit (the enabled toggle, a description) skips the probe, so
 * an unreachable server can still be disabled.
 */
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
      }),
      { requireConnection: context.existing === null },
    );
    const connection = await resolveConnection(ctx, context, input);
    const touchesConnection =
      context.existing === null ||
      args.url !== undefined ||
      args.bundle !== undefined ||
      args.headers !== undefined;
    const probe = touchesConnection
      ? await probeServer(context.accountId, input.name!, connection)
      : { verified: true, tools: [] };
    const serverId = await writeRow(ctx, context, args, input, connection);

    return { serverId: serverId, verified: probe.verified, tools: probe.tools };
  },
});

/** The node's active server row, shared by the public query and the save path. */
async function activeServerByNode(
  ctx: QueryCtx,
  stageId: Id<"stages">,
  nodeId: string,
): Promise<Doc<"mcp"> | null> {
  // More than one row can carry the node id: deleting a server on the canvas
  // and redeploying leaves a soft-deleted row beside the new one. Pick the
  // active row rather than whichever the index returns first, or the server
  // reads as missing for good.
  const servers = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_nodeId", (q) =>
      q.eq("stageId", stageId).eq("nodeId", nodeId),
    )
    .collect();

  return servers.find((server) => server.status === "active") ?? null;
}

/** tools/list through core, unwrapping the { tools } envelope. */
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

/** One rpc round trip to core's /v1/mcp-service/rpc, error text surfaced. */
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

/** Canvas labels become the server name, which namespaces tools as name__tool. */
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

/**
 * Verify through core before writing. ${NAME} headers only resolve inside an
 * agent config, so those rows save unverified instead of failing the probe.
 */
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

/** The node's active server row, or a thrown error for the explorer verbs. */
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

/** New input wins; an existing row fills a metadata-only edit. */
async function resolveConnection(
  ctx: ActionCtx,
  context: NodeContext,
  input: McpInput,
): Promise<ResolvedConnection> {
  const existing = context.existing;
  const transport = input.transport ?? existing?.transport ?? "http";
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
    bundleStorageKey: stored.bundleStorageKey,
    sha256: stored.sha256,
    headers: input.headers ?? existing?.headers,
  });
}

/** Upload a changed bundle, or carry the existing row's stored one forward. */
async function storeBundle(
  ctx: ActionCtx,
  context: NodeContext,
  input: McpInput,
): Promise<{ bundleStorageKey: string; sha256: string } | null> {
  const bundleStorageKey = await storeMcpBundle(
    ctx,
    context.accountId,
    input,
    context.existing,
  );
  if (bundleStorageKey !== undefined) {
    return { bundleStorageKey: bundleStorageKey, sha256: input.sha256! };
  }
  const existing = context.existing;
  if (existing?.bundleStorageKey && existing.sha256) {
    return {
      bundleStorageKey: existing.bundleStorageKey,
      sha256: existing.sha256,
    };
  }

  return null;
}

/** Create or update the row once the probe has passed. */
async function writeRow(
  ctx: ActionCtx,
  context: NodeContext,
  args: NodeScope & { nodeLabel: string; sourceCode?: string },
  input: McpInput,
  connection: ResolvedConnection,
): Promise<Id<"mcp">> {
  const sourceCode =
    connection.transport === "hosted" ? args.sourceCode : undefined;
  const shared = stripUndefined({
    ...connection,
    name: input.name,
    description: input.description,
    disabled: input.disabled,
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
