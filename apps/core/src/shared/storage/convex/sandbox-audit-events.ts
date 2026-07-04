/**
 * Convex mirror writes for sandbox lifecycle audit events. These are
 * best-effort: lifecycle calls should not fail if the audit mirror is
 * temporarily unavailable.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const internal: any = require("@broods/convex/_generated/api").internal;
import { getConvexClient } from "./client.ts";
import { logError } from "../../log.ts";
import type { SandboxProvider } from "../sandbox-config.ts";
import type { SandboxInstanceStatus } from "./sandbox-instances.ts";

/** Sandbox lifecycle actions represented in the audit stream. */
export type SandboxAuditAction =
  | "reserve"
  | "suspend"
  | "resume"
  | "terminate"
  | "snapshot"
  | "refresh"
  | "exec"
  | "terminal";

/** Actor metadata propagated from dashboard/agent/service callers. */
export interface SandboxAuditActor {
  source: "dashboard" | "agent" | "service" | "unknown";
  id?: string;
  email?: string;
  name?: string;
}

/** Convex mode is active only when both env vars are present (see CLAUDE.md). */
function convexEnabled(): boolean {
  return Boolean(process.env.CONVEX_URL && process.env.CONVEX_DEPLOY_KEY);
}

/** Records one sandbox lifecycle audit event in Convex when Convex is enabled. */
export async function recordSandboxAuditEvent(input: {
  accountId: string;
  sandboxConfigId?: string;
  reservationKey: string;
  provider: SandboxProvider;
  action: SandboxAuditAction;
  result: "ok" | "error";
  status?: SandboxInstanceStatus;
  actor?: SandboxAuditActor;
  traceId?: string;
  taskId?: string;
  errorMessage?: string;
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
}): Promise<void> {
  if (!convexEnabled()) return;
  const actor = input.actor ?? { source: "unknown" as const };
  try {
    await getConvexClient().mutation(internal.sandboxAuditEvents.insert, {
      accountId: input.accountId as any,
      ...(input.sandboxConfigId ? { sandboxConfigId: input.sandboxConfigId as any } : {}),
      reservationKey: input.reservationKey,
      provider: input.provider,
      action: input.action,
      result: input.result,
      ...(input.status ? { status: input.status } : {}),
      actorSource: actor.source,
      ...(actor.id ? { actorId: actor.id } : {}),
      ...(actor.email ? { actorEmail: actor.email } : {}),
      ...(actor.name ? { actorName: actor.name } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
    });
  } catch (err) {
    logError("Sandbox audit mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
