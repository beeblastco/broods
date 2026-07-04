/**
 * Convex mirror writes for sandbox instance lifecycle. The account-manage
 * suspend/resume/terminate endpoints call these after the provider lifecycle
 * call succeeds so the dashboard's live sandboxInstances query reflects the new
 * state. Fire-and-forget safe — gated on convex mode and wrapped so a mirror
 * failure never fails the lifecycle request. See usage.ts for the same pattern.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@broods/convex/_generated/api").internal;
import { getConvexClient } from "./client.ts";
import { logError } from "../../log.ts";
import type { SandboxControlPlane, SandboxRunMetadata } from "../../sandbox-sizes.ts";
import type { SandboxProvider } from "../sandbox-config.ts";
import { recordSandboxAuditEvent } from "./sandbox-audit-events.ts";

/** Convex mode is active only when both env vars are present (see CLAUDE.md). */
function convexEnabled(): boolean {
  return Boolean(process.env.CONVEX_URL && process.env.CONVEX_DEPLOY_KEY);
}

export type SandboxInstanceStatus = "running" | "suspended" | "terminating" | "error";

/**
 * Mirrors a freshly reserved persistent sandbox into Convex so the dashboard sees
 * it live. No-op outside convex mode or when the config carries no control-plane
 * identity (synthetic/stateless configs). Idempotent — safe on reconnect.
 */
export async function upsertSandboxInstance(
  controlPlane: SandboxControlPlane | undefined,
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  metadata?: SandboxRunMetadata,
): Promise<void> {
  if (!controlPlane || !convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandboxInstances.upsert, {
      accountId: controlPlane.accountId as any,
      ...(controlPlane.projectId ? { projectId: controlPlane.projectId as any } : {}),
      ...(controlPlane.environmentId ? { environmentId: controlPlane.environmentId as any } : {}),
      provider,
      reservationKey,
      externalId,
      name: controlPlane.name,
      specs: controlPlane.specs,
      ...(controlPlane.sandboxConfigId ? { sandboxConfigId: controlPlane.sandboxConfigId as any } : {}),
      ...(controlPlane.snapshotId ? { snapshotId: controlPlane.snapshotId } : {}),
      ...(controlPlane.egress ? { egress: controlPlane.egress } : {}),
      ...(controlPlane.permissionMode ? { permissionMode: controlPlane.permissionMode } : {}),
      ...(metadata?.traceId ? { lastUsedTraceId: metadata.traceId, createdByTraceId: metadata.traceId } : {}),
      ...(metadata?.taskId ? { lastUsedTaskId: metadata.taskId, createdByTaskId: metadata.taskId } : {}),
      ...(metadata?.agentId ? { agentId: metadata.agentId } : {}),
      ...(metadata?.conversationKey ? { conversationKey: metadata.conversationKey } : {}),
      ...(metadata?.workspaceName ? { workspaceName: metadata.workspaceName } : {}),
      ...(metadata?.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    });
    await recordSandboxAuditEvent({
      accountId: controlPlane.accountId,
      ...(controlPlane.sandboxConfigId ? { sandboxConfigId: controlPlane.sandboxConfigId } : {}),
      reservationKey,
      provider,
      action: "reserve",
      result: "ok",
      status: "running",
      actor: {
        source: metadata?.agentId ? "agent" : "service",
        ...(metadata?.agentId ? { id: metadata.agentId } : {}),
      },
      ...(metadata?.traceId ? { traceId: metadata.traceId } : {}),
      ...(metadata?.taskId ? { taskId: metadata.taskId } : {}),
    });
  } catch (err) {
    logError("Sandbox instance upsert mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mirrors a suspend/resume status transition into Convex. No-op outside convex
 * mode or when no row matches the reservation key.
 */
export async function setSandboxInstanceStatus(
  accountId: string,
  reservationKey: string,
  status: SandboxInstanceStatus,
): Promise<void> {
  if (!convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandboxInstances.setStatus, {
      accountId: accountId as any,
      reservationKey,
      status,
    });
  } catch (err) {
    logError("Sandbox instance status mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Removes a terminated instance's row from Convex. No-op outside convex mode or
 * when no row matches the reservation key.
 */
export async function removeSandboxInstance(accountId: string, reservationKey: string): Promise<void> {
  if (!convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandboxInstances.remove, {
      accountId: accountId as any,
      reservationKey,
    });
  } catch (err) {
    logError("Sandbox instance remove mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
