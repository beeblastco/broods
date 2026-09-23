/**
 * Starts queued work that no live owner will drain. Admission recovers a
 * conversation when its next message arrives; this covers the ones nobody
 * writes to again, such as the queue behind a run a previous pod handed back
 * at shutdown or died holding. Runs on boot and on a timer; Convex promotes
 * each queue atomically, so an overlapping pod never runs one twice.
 */

import { logError, logInfo } from "../shared/log.ts";
import { publicConversationKeyFromScoped } from "../shared/runtime-keys.ts";
import { dispatchAppliedIngress } from "./handler.ts";
import { recoverQueuedIngress, type RecoveredIngress } from "./ingress.ts";

// A lease handed back at shutdown is picked up within this, or on boot.
const RECOVERY_INTERVAL_MS = 30_000;

let recovery: ReturnType<typeof setInterval> | undefined;
let sweeping = false;

/** Sweeps once now, then on a timer. No-op when it is already running. */
export function startIngressRecovery(): void {
  if (recovery) return;
  void sweepQueuedIngress();
  recovery = setInterval(() => void sweepQueuedIngress(), RECOVERY_INTERVAL_MS);
  // A pending sweep must not hold the process open past SIGTERM.
  recovery.unref();
}

/** Stops the timer. Shutdown calls it first so a sweep never starts new work. */
export function stopIngressRecovery(): void {
  if (!recovery) return;
  clearInterval(recovery);
  recovery = undefined;
}

/**
 * One pass: promote every orphaned queue and dispatch what it returns. A
 * dispatch that fails settles its envelope and drains on, like any other.
 * @returns how many applications were dispatched
 */
export async function sweepQueuedIngress(): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    const recovered = await recoverQueuedIngress();
    for (const entry of recovered) {
      await dispatchAppliedIngress(recoveryScope(entry), entry.applied).catch(
        (err: unknown) => {
          logError("Recovered ingress dispatch failed", {
            conversationKey: entry.conversationKey,
            eventId: entry.applied.eventId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }
    if (recovered.length > 0) {
      logInfo("Recovered queued ingress", { count: recovered.length });
    }

    return recovered.length;
  } catch (err) {
    logError("Queued ingress recovery failed", {
      error: err instanceof Error ? err.message : String(err),
    });

    return 0;
  } finally {
    sweeping = false;
  }
}

/** The dispatch scope an envelope carries itself, since no request names it. */
function recoveryScope(
  entry: RecoveredIngress,
): Parameters<typeof dispatchAppliedIngress>[0] {
  const delivery = entry.applied.delivery;
  const deployment =
    delivery.kind === "channel" ? undefined : delivery.publicDeploymentIngress;

  return {
    accountId: entry.accountId,
    agentId: entry.agentId,
    agentConfig: entry.applied.agentConfig ?? {},
    conversationKey: entry.conversationKey,
    publicConversationKey: publicConversationKeyFromScoped(
      entry.conversationKey,
      entry.accountId,
      entry.agentId,
    ),
    ...(deployment
      ? {
          endpointId: deployment.endpointId,
          projectSlug: deployment.projectSlug,
          stageSlug: deployment.stageSlug,
        }
      : {}),
  };
}
