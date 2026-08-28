/**
 * Storage mirror writes for sandbox instance lifecycle, plus the ownership read
 * those endpoints authorize against. The account-manage suspend/resume/terminate
 * endpoints call the writes after the provider lifecycle call succeeds so the
 * dashboard's live sandboxInstances query reflects the new state. Fire-and-forget
 * safe — gated on convex mode and wrapped so a mirror failure never fails the
 * lifecycle request. See usage.ts for the same pattern.
 */

const internal: any = require("@broods/convex/_generated/api").internal;
import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { logError } from "../log.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
} from "../sandbox-sizes.ts";
import { getConvexClient } from "./client.ts";
import { recordSandboxAuditEvent } from "./sandbox-audit-events.ts";

/** Convex mode is active only when both env vars are present (see CLAUDE.md). */
function convexEnabled(): boolean {
  return Boolean(process.env.CONVEX_URL && process.env.CONVEX_DEPLOY_KEY);
}

export type SandboxInstanceStatus =
  | "running"
  | "suspended"
  | "terminating"
  | "error";

/**
 * Mirrors a freshly reserved persistent sandbox into Convex so the dashboard sees
 * it live. No-op outside convex mode or when the config carries no control-plane
 * identity (synthetic/stateless configs). Idempotent — safe on reconnect.
 *
 * `ephemeral` marks a per-call instance: the row exists only while the call runs, so
 * it is flagged uncontrollable for the dashboard and skips the audit event a real
 * reservation writes (one per bash call would drown the sandbox's own history).
 */
export async function upsertSandboxInstance(
  controlPlane: SandboxControlPlane | undefined,
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  metadata?: SandboxRunMetadata,
  options?: { ephemeral?: boolean },
): Promise<void> {
  if (!controlPlane || !convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandbox.instances.upsert, {
      accountId: controlPlane.accountId as any,
      ...(controlPlane.projectId
        ? { projectId: controlPlane.projectId as any }
        : {}),
      ...(controlPlane.stageId ? { stageId: controlPlane.stageId as any } : {}),
      provider: provider,
      reservationKey: reservationKey,
      externalId: externalId,
      name: controlPlane.name,
      specs: controlPlane.specs,
      ...(controlPlane.sandboxConfigId
        ? { sandboxConfigId: controlPlane.sandboxConfigId as any }
        : {}),
      ...(controlPlane.snapshotId
        ? { snapshotId: controlPlane.snapshotId }
        : {}),
      ...(controlPlane.egress ? { egress: controlPlane.egress } : {}),
      ...(controlPlane.permissionMode
        ? { permissionMode: controlPlane.permissionMode }
        : {}),
      ...(metadata?.traceId
        ? {
            lastUsedTraceId: metadata.traceId,
            createdByTraceId: metadata.traceId,
          }
        : {}),
      ...(metadata?.taskId
        ? { lastUsedTaskId: metadata.taskId, createdByTaskId: metadata.taskId }
        : {}),
      ...(metadata?.agentId ? { agentId: metadata.agentId } : {}),
      ...(metadata?.conversationKey
        ? { conversationKey: metadata.conversationKey }
        : {}),
      ...(metadata?.workspaceName
        ? { workspaceName: metadata.workspaceName }
        : {}),
      ...(metadata?.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
      ...(options?.ephemeral ? { ephemeral: true } : {}),
    });
    if (options?.ephemeral) return;
    await recordSandboxAuditEvent({
      accountId: controlPlane.accountId,
      ...(controlPlane.sandboxConfigId
        ? { sandboxConfigId: controlPlane.sandboxConfigId }
        : {}),
      reservationKey: reservationKey,
      provider: provider,
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
 * @param observed the status was read off the provider, not caused by a use, so
 * it must not move the row's "last used" clock.
 */
export async function setSandboxInstanceStatus(
  accountId: string,
  reservationKey: string,
  status: SandboxInstanceStatus,
  observed = false,
): Promise<void> {
  if (!convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandbox.instances.setStatus, {
      accountId: accountId as any,
      reservationKey: reservationKey,
      status: status,
      observed: observed,
    });
  } catch (err) {
    logError("Sandbox instance status mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The reservation's ownership record: does it still bind to this account + sandbox config.
 * Not fire-and-forget like the writes — a failure must surface, never deny the request.
 */
export async function sandboxInstanceIsControllable(
  accountId: string,
  sandboxConfigId: string,
  reservationKey: string,
): Promise<boolean> {
  const controllable = await getConvexClient().query(
    internal.sandbox.instances.isControllable,
    {
      accountId: accountId as any,
      sandboxConfigId: sandboxConfigId as any,
      reservationKey: reservationKey,
    },
  );

  return controllable === true;
}

/**
 * Removes a terminated instance's row from Convex. No-op outside convex mode or
 * when no row matches the reservation key.
 */
export async function removeSandboxInstance(
  accountId: string,
  reservationKey: string,
): Promise<void> {
  if (!convexEnabled()) return;
  try {
    await getConvexClient().mutation(internal.sandbox.instances.remove, {
      accountId: accountId as any,
      reservationKey: reservationKey,
    });
  } catch (err) {
    logError("Sandbox instance remove mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
