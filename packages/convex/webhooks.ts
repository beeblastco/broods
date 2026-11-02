import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import { normalizeWebhookHookConfig } from "./model/agentRules";
import {
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
} from "./model/agentSync";
import {
  accountIdForProject,
  auditDetailsJson,
  dashboardAuditActor,
  appendAuditEvent,
  type AuditActor,
} from "./model/auditEvents";
import { isPlainObject } from "./model/objects";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForWrite } from "./model/ownership/project";

// A webhook can send agent events to any host, so editing one is admin-only.
const WEBHOOK_ADMIN_REQUIRED =
  "Agent webhooks can only be changed by an org admin.";

const webhookRow = v.object({
  index: v.number(),
  enabled: v.boolean(),
  url: v.optional(v.string()),
  hasSecret: v.boolean(),
  events: v.array(v.string()),
});

export const addAgentWebhook = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
    url: v.string(),
    secret: v.string(),
    events: v.optional(v.array(v.string())),
    enabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { agentConfigId, url, secret, events, enabled },
  ): Promise<null> => {
    const user = await requireUser(ctx);
    await mutateAgentWebhooks(
      ctx,
      user.id,
      agentConfigId,
      (webhooks): Record<string, unknown>[] => {
        // The config plane's rules, so the dashboard cannot store a webhook the API refuses.
        const webhook = {
          enabled: enabled !== false,
          url: url.trim(),
          secret: secret.trim(),
          events: events ?? [],
        };
        normalizeWebhookHookConfig(webhook, "webhook");

        return [...webhooks, webhook];
      },
    );
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

export const removeAgentWebhook = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
    index: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { agentConfigId, index }): Promise<null> => {
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

export const setAgentWebhookEnabled = mutation({
  args: {
    agentConfigId: v.id("agentConfigs"),
    index: v.number(),
    enabled: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { agentConfigId, index, enabled }): Promise<null> => {
    const user = await requireUser(ctx);
    await mutateAgentWebhooks(ctx, user.id, agentConfigId, (webhooks) =>
      webhooks.map((webhook, i): Record<string, unknown> => {
        if (i !== index) {
          return webhook;
        }
        const next = { ...webhook, enabled: enabled };
        // A row that predates a tightened rule can be disabled, but not re-enabled until fixed.
        if (enabled) {
          normalizeWebhookHookConfig(next, "webhook");
        }

        return next;
      }),
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

async function mutateAgentWebhooks(
  ctx: MutationCtx,
  authId: string,
  agentConfigId: Id<"agentConfigs">,
  mutate: (webhooks: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<void> {
  const config = await ctx.db.get(agentConfigId);
  if (!config) throw new Error("Agent config not found.");
  if (!(await getProjectForWrite(ctx, authId, config.projectId, "admin"))) {
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
  const accountId = await accountIdForProject(ctx, config.projectId);
  if (accountId) {
    await ensureAgentsRowForConfig(ctx, agentConfigId, authId, accountId);
    await pushEncryptedConfigToAgentRow(ctx, agentConfigId, accountId);
  }
}

function readWebhooks(extraConfig: unknown): Record<string, unknown>[] {
  const hooks =
    isPlainObject(extraConfig) && isPlainObject(extraConfig.hooks)
      ? extraConfig.hooks
      : undefined;
  const webhooks = hooks && Array.isArray(hooks.webhooks) ? hooks.webhooks : [];

  return webhooks.filter(isPlainObject);
}

async function recordWebhookAudit(
  ctx: MutationCtx,
  actor: AuditActor,
  agentConfigId: Id<"agentConfigs">,
  action: string,
  summary: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const config = await ctx.db.get(agentConfigId);
  if (!config) return;
  const accountId = await accountIdForProject(ctx, config.projectId);
  if (!accountId) return;

  await appendAuditEvent(ctx.db, {
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

async function requireUser(
  ctx: MutationCtx,
): Promise<{ id: string; email?: string | null; name?: string | null }> {
  const user = await authKit.getAuthUser(ctx);
  if (!user) {
    throw new Error("User not found or not authenticated");
  }

  return user;
}
