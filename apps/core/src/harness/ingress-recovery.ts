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
import type { IngressDispatchScope } from "./integrations.ts";

// A lease handed back at shutdown is picked up within this, or on boot.
const RECOVERY_INTERVAL_MS = 30_000;
// What one sweep walks before it hands the rest to the next: pages of queued
// conversations, and queues it promotes, which all land on this pod's worker
// queue. The next sweep resumes where this one stopped.
const MAX_RECOVERY_PAGES = 50;
const MAX_RECOVERED_PER_SWEEP = 100;

let recovery: ReturnType<typeof setInterval> | undefined;
let sweeping = false;
let resumeAfter: string | undefined;

/** Sweeps once now, then on a timer. No-op when it is already running. */
export function startIngressRecovery(): void {
  if (recovery) return;
  void sweepQueuedIngress();
  recovery = setInterval(
    (): void => void sweepQueuedIngress(),
    RECOVERY_INTERVAL_MS,
  );
  // A pending sweep must not hold the process open past SIGTERM.
  recovery.unref();
}

/** Stops the timer. Shutdown calls it first so a sweep never starts new work. */
export function stopIngressRecovery(): void {
  if (!recovery) return;
  clearInterval(recovery);
  recovery = undefined;
}

/** The dispatch scope an envelope carries itself, since no request names it. */
function recoveryScope(entry: RecoveredIngress): IngressDispatchScope {
  const delivery = entry.applied.delivery;
  const deployment =
    delivery.kind === "channel" ? undefined : delivery.publicDeploymentIngress;

  return {
    accountId: entry.accountId,
    agentId: entry.agentId,
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

/**
 * One pass: promote orphaned queues and dispatch what they return, a page of
 * queued conversations at a time, from where the last pass stopped. Each entry
 * is its own conversation, so a page dispatches together. A dispatch that
 * fails settles its envelope and drains on, like any other.
 */
async function sweepQueuedIngress(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  let count = 0;
  try {
    for (
      let page = 0;
      page < MAX_RECOVERY_PAGES && count < MAX_RECOVERED_PER_SWEEP;
      page += 1
    ) {
      const { recovered, continueAfter } =
        await recoverQueuedIngress(resumeAfter);
      count += recovered.length;
      await Promise.all(
        recovered.map((entry): Promise<void> =>
          dispatchAppliedIngress(recoveryScope(entry), entry.applied).catch(
            (err: unknown): void => {
              logError("Recovered ingress dispatch failed", {
                conversationKey: entry.conversationKey,
                eventId: entry.applied.eventId,
                error: err instanceof Error ? err.message : String(err),
              });
            },
          ),
        ),
      );
      resumeAfter = continueAfter ?? undefined;
      if (continueAfter === null) break;
    }
  } catch (err) {
    logError("Queued ingress recovery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    sweeping = false;
    if (count > 0) {
      logInfo("Recovered queued ingress", { count: count });
    }
  }
}
