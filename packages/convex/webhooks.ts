/**
 * Outbound webhook views and editing for the dashboard. The harness delivers
 * events from each agent's `config.hooks.webhooks` array; this module surfaces
 * those per-agent hooks for a stage and lets the settings tab add, toggle,
 * and remove them. There is no separate webhook store — the agent config is the
 * source of truth.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import {
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
} from "./model/agentSync";
import {
  accountIdForProject,
  auditDetailsJson,
  dashboardAuditActor,
  insertConfigAuditEvent,
  type ConfigAuditActor,
} from "./model/auditEvents";
import { isPlainObject } from "./model/objects";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForRole } from "./model/ownership/project";

// Webhook URLs and signing secrets can point agent events at any host, so
// editing them is an org admin operation. The secret itself is write-only.
const WEBHOOK_ADMIN_REQUIRED =
  "Agent webhooks can only be changed by an org admin.";

/** One outbound webhook configured on an agent (URL/secret usually resolve from env vars). */
const webhookRow = v.object({
  index: v.number(),
  enabled: v.boolean(),
  url: v.optional(v.string()),
  /** Whether a signing secret is set; the value never leaves the store. */
  hasSecret: v.boolean(),
  events: v.array(v.string()),
});

/** Reads the `hooks.webhooks` array out of an agent config's `extraConfig` blob. */
function readWebhooks(extraConfig: unknown): Record<string, unknown>[] {
  const hooks =
    isPlainObject(extraConfig) && isPlainObject(extraConfig.hooks)
      ? extraConfig.hooks
      : undefined;
  const webhooks = hooks && Array.isArray(hooks.webhooks) ? hooks.webhooks : [];

  return webhooks.filter(isPlainObject);
}

/**
 * List every agent in a stage with its configured outbound webhooks. Agents
 * with no webhooks are still returned so the settings tab can offer an empty agent
 * to add one to.
 * @returns one entry per agent, each carrying its indexed webhook rows
 */
export const listAgentWebhooks = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.array(
    v.object({
      agentConfigId: v.id("agentConfigs"),
      agentName: v.string(),
      webhooks: v.array(webhookRow),
    }),
  ),
  handler: async (ctx, { projectId, stageId }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      return [];
    }

    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();

    return configs.map((config) => ({
      agentConfigId: config._id,
      agentName: config.name,
      webhooks: readWebhooks(config.extraConfig).map((webhook, index) => ({
        index: index,
        enabled: webhook.enabled !== false,
        url: typeof webhook.url === "string" ? webhook.url : undefined,
        hasSecret:
          typeof webhook.secret === "string" && webhook.secret.length > 0,
        events: Array.isArray(webhook.events)
          ? webhook.events.filter(
              (event): event is string => typeof event === "string",
            )
          : [],
      })),
    }));
  },
});

/**
 * Load an owned agent config, apply a transform to its `hooks.webhooks` array, and
 * persist the result back into `extraConfig` plus the encrypted runtime agents row.
 * @param mutate receives the current webhooks and returns the next array
 * @throws when the config is missing or the caller does not own its project
 */
async function mutateAgentWebhooks(
  ctx: MutationCtx,
  authId: string,
  agentConfigId: Id<"agentConfigs">,
  mutate: (webhooks: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  const config = await ctx.db.get(agentConfigId);
  if (!config) throw new Error("Agent config not found.");
  if (!(await getProjectForRole(ctx, authId, config.projectId, "admin"))) {
    throw new Error(WEBHOOK_ADMIN_REQUIRED);
  }

  const extra: Record<string, unknown> = isPlainObject(config.extraConfig)
    ? { ...config.extraConfig }
    : {};
  const hooks: Record<string, unknown> = isPlainObject(extra.hooks)
    ? { ...extra.hooks }
    : {};
  hooks.webhooks = mutate(readWebhooks(config.extraConfig));
  extra.hooks = hooks;

  await ctx.db.patch(agentConfigId, {
    extraConfig: extra,
    updatedAt: Date.now(),
  });
  await ensureAgentsRowForConfig(ctx, agentConfigId, authId);
  await pushEncryptedConfigToAgentRow(ctx, agentConfigId);
}

async function requireUser(
  ctx: MutationCtx,
): Promise<{ id: string; email?: string | null; name?: string | null }> {
  // Check authenticated user
  const user = await authKit.getAuthUser(ctx);
  if (!user) {
    throw new Error("User not found or not authenticated");
  }

  return user;
}

async function recordWebhookAudit(
  ctx: MutationCtx,
  actor: ConfigAuditActor,
  agentConfigId: Id<"agentConfigs">,
  action: string,
  summary: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const config = await ctx.db.get(agentConfigId);
  if (!config) return;
  const accountId = await accountIdForProject(ctx, config.projectId);
  if (!accountId) return;

  await insertConfigAuditEvent(ctx.db, {
    accountId: accountId,
    projectId: config.projectId,
    stageId: config.stageId,
    actor: actor,
    action: action,
    resource: {
      kind: "webhook",
      id: `${agentConfigId}:${typeof data?.index === "number" ? data.index : "new"}`,
      name: config.name,
    },
    summary: summary,
    detailsJson: auditDetailsJson({
      agentConfigId: agentConfigId,
      agentId: config.agentId,
      ...data,
    }),
  });
}

/**
 * Append a new outbound webhook to an agent.
 * @returns null
 */
export const addAgentWebhook = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
    url: v.string(),
    secret: v.string(),
    events: v.optional(v.array(v.string())),
    enabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { agentConfigId, url, secret, events, enabled }) => {
    const user = await requireUser(ctx);
    await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) => [
      ...webhooks,
      {
        enabled: enabled !== false,
        url: url.trim(),
        secret: secret.trim(),
        events: events ?? [],
      },
    ]);
    await recordWebhookAudit(
      ctx,
      dashboardAuditActor(user),
      agentConfigId,
      "created",
      "Agent webhook created",
      {
        events: events ?? [],
        enabled: enabled !== false,
      },
    );

    return null;
  },
});

/**
 * Enable or disable a single webhook on an agent by its index.
 * @returns null
 */
export const setAgentWebhookEnabled = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
    index: v.number(),
    enabled: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { agentConfigId, index, enabled }) => {
    const user = await requireUser(ctx);
    await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) =>
      webhooks.map((webhook, i) =>
        i === index ? { ...webhook, enabled: enabled } : webhook,
      ),
    );
    await recordWebhookAudit(
      ctx,
      dashboardAuditActor(user),
      agentConfigId,
      "updated",
      "Agent webhook updated",
      {
        index: index,
        enabled: enabled,
      },
    );

    return null;
  },
});

/**
 * Remove a webhook from an agent by its index.
 * @returns null
 */
export const removeAgentWebhook = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
    index: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { agentConfigId, index }) => {
    const user = await requireUser(ctx);
    await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) =>
      webhooks.filter((_, i) => i !== index),
    );
    await recordWebhookAudit(
      ctx,
      dashboardAuditActor(user),
      agentConfigId,
      "deleted",
      "Agent webhook deleted",
      {
        index: index,
      },
    );

    return null;
  },
});
