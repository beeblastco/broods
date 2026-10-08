/**
 * Storage mirror writes for sandbox instance lifecycle, plus the ownership read
 * those endpoints authorize against. The account-manage suspend/resume/terminate
 * endpoints write after the provider lifecycle call succeeds, so the dashboard's
 * live sandboxInstances query reflects the new state. Wrapped so a mirror failure
 * never fails the lifecycle request, the same pattern as usage.ts.
 */

const internal: any = require("@broods/convex/_generated/api").internal;
import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { logError } from "../log.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
  SandboxSpecs,
} from "../sandbox-sizes.ts";
import { getConvexClient } from "./client.ts";

// A lost remove leaves a row the meter keeps billing, so it is retried
// through a Convex blip. The remove is idempotent, so a repeat is harmless.
const REMOVE_RETRY_DELAYS_MS = [0, 500, 2_000];

export type SandboxInstanceStatus =
  | "running"
  | "suspended"
  | "terminating"
  | "error";

/**
 * Mirrors a freshly reserved persistent sandbox into Convex so the dashboard sees
 * it live. No-op when the config carries no control-plane identity
 * (synthetic/stateless configs). Idempotent, so it is safe on reconnect.
 *
 * `ephemeral` marks a per-call instance: the row exists only while the call runs, so
 * it is flagged uncontrollable for the dashboard. The `reserve` audit row is written
 * by the mutation, in the same transaction as the insert; a reconnect refreshes the
 * row's last-used trace instead of adding a row per tool call.
 * `logStream` is the provider-side guest log stream the dashboard tails. Only the
 * call that launched the VM knows it; reconnects leave the stored value alone.
 * `specs` is the machine's real size, which the executor passes only when it
 * knows it: reported by the provider, or set by Broods itself. Without it the
 * row bills the size derived from the config but is not marked verified, so
 * that guess is never shown as the machine's size.
 */
export async function upsertSandboxInstance(
  controlPlane: SandboxControlPlane | undefined,
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  metadata?: SandboxRunMetadata,
  options?: { ephemeral?: boolean; logStream?: string; specs?: SandboxSpecs },
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
      specs: options?.specs ?? controlPlane.specs,
      specsVerified: options?.specs !== undefined ? true : undefined,
      sandboxConfigId: controlPlane.sandboxConfigId as any,
      snapshotId: controlPlane.snapshotId,
      egress: controlPlane.egress,
      permissionMode: controlPlane.permissionMode,
      ownCredentials: controlPlane.ownCredentials,
      idleTimeoutSeconds: controlPlane.idleTimeoutSeconds,
      lastUsedTraceId: meta.traceId,
      createdByTraceId: meta.traceId,
      lastUsedTaskId: meta.taskId,
      createdByTaskId: meta.taskId,
      agentId: meta.agentId,
      conversationKey: meta.conversationKey,
      workspaceName: meta.workspaceName,
      workspaceId: meta.workspaceId,
      logStream: options?.logStream,
      ephemeral: ephemeral ? true : undefined,
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
 * @param options.observed the status was read off the provider, not caused by a
 * use, so it must not move the row's "last used" clock.
 * @param options.errorMessage the provider's reason for an "error" status.
 * @returns whether the row's status moved; false when there was no row or the mirror failed.
 */
export async function setSandboxInstanceStatus(
  accountId: string,
  reservationKey: string,
  status: SandboxInstanceStatus,
  options?: { observed?: boolean; errorMessage?: string },
): Promise<boolean> {
  try {
    const changed: boolean = await getConvexClient().mutation(
      internal.sandbox.instances.setStatus,
      {
        accountId: accountId as any,
        reservationKey: reservationKey,
        status: status,
        observed: options?.observed === true,
        errorMessage: options?.errorMessage,
      },
    );

    return changed;
  } catch (err) {
    logError("Sandbox instance status mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });

    return false;
  }
}

/**
 * The reservation's ownership record: does it still bind to this account + sandbox config.
 * Not fire-and-forget like the writes. A failure must surface, never deny the request.
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
 * Bills a MicroVM's burst from the running totals its guest reports: vCPU-s and
 * GB-s above the baseline since boot. The meter bills only the growth, so a
 * repeat is harmless. False when nothing was billed because the write failed or
 * the VM has no row yet, so the caller sends the totals again.
 */
export async function recordSandboxBurst(
  accountId: string,
  externalId: string,
  totals: { vcpuSeconds: number; gbSeconds: number },
): Promise<boolean> {
  try {
    return await getConvexClient().mutation(
      internal.sandbox.instances.recordBurst,
      {
        accountId: accountId,
        externalId: externalId,
        vcpuSeconds: totals.vcpuSeconds,
        gbSeconds: totals.gbSeconds,
      },
    );
  } catch (err) {
    logError("Sandbox burst mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });

    return false;
  }
}

/**
 * Removes a terminated instance's row, retried a few times before it is logged
 * and given up. No-op when no row matches the key, or when `externalId` is given
 * and the row has since been repointed at another machine.
 */
export async function removeSandboxInstance(
  accountId: string,
  reservationKey: string,
  externalId?: string,
): Promise<void> {
  try {
    // Built once, outside the retries: a missing Convex config is not a blip.
    const client = getConvexClient();
    for (const [attempt, delayMs] of REMOVE_RETRY_DELAYS_MS.entries()) {
      await Bun.sleep(delayMs);
      try {
        await client.mutation(internal.sandbox.instances.remove, {
          accountId: accountId as any,
          reservationKey: reservationKey,
          externalId: externalId,
        });

        return;
      } catch (err) {
        if (attempt === REMOVE_RETRY_DELAYS_MS.length - 1) throw err;
      }
    }
  } catch (err) {
    logError("Sandbox instance remove mirror failed (convex)", {
      reservationKey: reservationKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
