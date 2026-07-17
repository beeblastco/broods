/**
 * Shared helpers for account-visible configuration audit events.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const DETAILS_JSON_LIMIT_BYTES = 8 * 1024;
const TRUNCATED_MARKER = "…[truncated]";

export type ConfigAuditActor = {
  kind:
    | "dashboardUser"
    | "apiAccountSecret"
    | "admin"
    | "service"
    | "cli"
    | "deployKey";
  id?: string;
  email?: string;
  name?: string;
};

export type ConfigAuditResource = {
  kind:
    | "account"
    | "agent"
    | "skill"
    | "tool"
    | "hook"
    | "workspace"
    | "workspaceFile"
    | "cron"
    | "sandbox"
    | "policy"
    | "environmentVariable"
    | "deployment"
    | "webhook"
    | "manifest"
    | "unknown";
  id?: string;
  name?: string;
};

export type ConfigAuditEventInput = {
  accountId: Id<"accounts">;
  projectId?: Id<"projects">;
  environmentId?: Id<"environments">;
  actor: ConfigAuditActor;
  action: string;
  resource: ConfigAuditResource;
  summary: string;
  detailsJson?: string;
};

/**
 * Insert a capped config audit event into Convex.
 * @param db Convex database writer.
 * @param event sanitized event metadata.
 * @returns the inserted audit event id.
 */
export async function insertConfigAuditEvent(
  db: MutationCtx["db"],
  event: ConfigAuditEventInput,
): Promise<Id<"configAuditEvents">> {
  return await db.insert("configAuditEvents", {
    accountId: event.accountId,
    projectId: event.projectId,
    environmentId: event.environmentId,
    actor: stripUndefined(event.actor),
    action: event.action,
    resource: stripUndefined(event.resource),
    summary: event.summary,
    detailsJson:
      event.detailsJson === undefined
        ? undefined
        : capDetailsJson(event.detailsJson),
  });
}

/**
 * Resolve the provisioned account for a project, if one exists.
 * @param ctx Convex query or mutation context.
 * @param projectId project whose org owns the account.
 * @returns the account id, or null before account provisioning.
 */
export async function accountIdForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
): Promise<Id<"accounts"> | null> {
  const project = await ctx.db.get(projectId);
  if (!project?.orgId) return null;
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
    .unique();

  return account?._id ?? null;
}

/**
 * Build dashboard actor metadata from an AuthKit user.
 * @param user AuthKit user metadata.
 * @returns audit actor fields for a dashboard mutation.
 */
export function dashboardAuditActor(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): ConfigAuditActor {
  return {
    kind: "dashboardUser",
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.name ? { name: user.name } : {}),
  };
}

/**
 * Serialize small non-secret metadata for the detailsJson field.
 * @param details ids, names, counts, or other non-secret metadata.
 * @returns JSON string capped at insert time.
 */
export function auditDetailsJson(details: Record<string, unknown>): string {
  return JSON.stringify(details);
}

function capDetailsJson(value: string): string {
  const encoder = new TextEncoder();
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength <= DETAILS_JSON_LIMIT_BYTES) return value;

  // The field must stay parseable JSON, so an oversized payload is replaced
  // with a sentinel carrying a prefix rather than truncated mid-token.
  return JSON.stringify({
    truncated: true,
    originalBytes: byteLength,
    prefix: `${value.slice(0, 1024)}${TRUNCATED_MARKER}`,
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
