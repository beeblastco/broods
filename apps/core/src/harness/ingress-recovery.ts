// Starts queued work no live owner will drain (a dead pod's queue, a late subagent result).
// Convex promotes queues and admits results atomically, so overlapping pods never run one twice.

import { logError, logInfo } from "../shared/log.ts";
import { publicConversationKeyFromScoped } from "../shared/runtime-keys.ts";
import { resumeLostAsyncToolResults } from "./async-tools.ts";
import {
  continueAfterAsyncToolSettlement,
  dispatchAppliedIngress,
  loadReentryTarget,
  resumeAfterSubagentResult,
} from "./handler.ts";
import { recoverQueuedIngress, type RecoveredIngress } from "./ingress.ts";
import type { IngressDispatchScope } from "./integrations.ts";
import { resumeLostSubagentResults } from "./subagents.ts";

const RECOVERY_INTERVAL_MS = 30_000;
// Everything one sweep promotes lands on this pod's worker queue; the next sweep resumes here.
const MAX_RECOVERY_PAGES = 50;
const MAX_RECOVERED_PER_SWEEP = 100;

let recovery: ReturnType<typeof setInterval> | undefined;
let sweeping = false;
let resumeAfter: string | undefined;

export function startIngressRecovery(): void {
  if (recovery) return;
  void sweepQueuedIngress();
  recovery = setInterval(
    (): void => void sweepQueuedIngress(),
    RECOVERY_INTERVAL_MS,
  );
  recovery.unref();
}

export function stopIngressRecovery(): void {
  if (!recovery) return;
  clearInterval(recovery);
  recovery = undefined;
}

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
  }
  if (count > 0) {
    logInfo("Recovered queued ingress", { count: count });
  }
  await resumeLostSubagentResults(
    loadReentryTarget,
    resumeAfterSubagentResult,
  ).catch((err: unknown): void => {
    logError("Lost subagent result recovery failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  await resumeLostAsyncToolResults(continueAfterAsyncToolSettlement).catch(
    (err: unknown): void => {
      logError("Lost async tool result recovery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
  sweeping = false;
}
