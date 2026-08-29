/**
 * Storage mirror writes for sandbox instance lifecycle, plus the ownership read
 * those endpoints authorize against. The account-manage suspend/resume/terminate
 * endpoints call the writes after the provider lifecycle call succeeds so the
 * dashboard's live sandboxInstances query reflects the new state. Fire-and-forget
 * safe — wrapped so a mirror failure never fails the lifecycle request. See usage.ts
 * for the same pattern.
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

export type SandboxInstanceStatus =
  | "running"
  | "suspended"
  | "terminating"
  | "error";

/**
 * Mirrors a freshly reserved persistent sandbox into Convex so the dashboard sees
 * it live. No-op when the config carries no control-plane identity
 * (synthetic/stateless configs). Idempotent — safe on reconnect.
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
  if (!controlPlane) return;
  const meta: SandboxRunMetadata = metadata ?? {};
  const ephemeral = options?.ephemeral === true;
  try {
    // The Convex client drops undefined object fields, so an unset optional
    // stays absent on the row rather than becoming null.
    await getConvexClient().mutation(internal.sandbox.instances.upsert, {
      accountId: controlPlane.accountId as any,
      projectId: controlPlane.projectId as any,
      stageId: controlPlane.stageId as any,
      provider: provider,
      reservationKey: reservationKey,
      externalId: externalId,
      name: controlPlane.name,
      specs: controlPlane.specs,
      sandboxConfigId: controlPlane.sandboxConfigId as any,
      snapshotId: controlPlane.snapshotId,
      egress: controlPlane.egress,
      permissionMode: controlPlane.permissionMode,
      lastUsedTraceId: meta.traceId,
      createdByTraceId: meta.traceId,
      lastUsedTaskId: meta.taskId,
      createdByTaskId: meta.taskId,
      agentId: meta.agentId,
      conversationKey: meta.conversationKey,
      workspaceName: meta.workspaceName,
      workspaceId: meta.workspaceId,
      ephemeral: ephemeral ? true : undefined,
    });
    if (ephemeral) return;
    await recordSandboxAuditEvent({
      accountId: controlPlane.accountId,
      sandboxConfigId: controlPlane.sandboxConfigId,
      reservationKey: reservationKey,
      provider: provider,
      action: "reserve",
      result: "ok",
      status: "running",
      actor: {
        source: meta.agentId ? "agent" : "service",
        id: meta.agentId,
      },
      traceId: meta.traceId,
      taskId: meta.taskId,
    });
  } catch (err) {
    logError("Sandbox instance upsert mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mirrors a suspend/resume status transition into Convex. No-op when no row
 * matches the reservation key.
 * @param observed the status was read off the provider, not caused by a use, so
 * it must not move the row's "last used" clock.
 */
export async function setSandboxInstanceStatus(
  accountId: string,
  reservationKey: string,
  status: SandboxInstanceStatus,
  observed = false,
): Promise<void> {
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

/** Removes a terminated instance's row. No-op when no row matches the key. */
export async function removeSandboxInstance(
  accountId: string,
  reservationKey: string,
): Promise<void> {
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
