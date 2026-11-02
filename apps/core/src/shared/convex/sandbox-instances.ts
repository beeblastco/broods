// Mirror writes log instead of failing the lifecycle call. Each keys on its own row, so all
// skip the mutation FIFO: order two writes to one row by awaiting or `queueMirrorWrite`.

import type { SandboxProvider } from "../domain/sandbox-config.ts";
import { logError } from "../log.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
  SandboxSpecs,
} from "../sandbox-sizes.ts";
import {
  adminMutation,
  adminQuery,
  getConvexClient,
  internal,
} from "./client.ts";

// A lost remove leaves a row the meter keeps billing; the remove is idempotent.
const REMOVE_RETRY_DELAYS_MS = [0, 500, 2_000];

export type SandboxInstanceStatus =
  | "running"
  | "suspended"
  | "terminating"
  | "error";

// Pass `specs` only when the real size is known; else the row bills the config's, unverified.
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
    await adminMutation(
      internal.sandbox.instances.upsert,
      {
        accountId: controlPlane.accountId,
        projectId: controlPlane.projectId,
        stageId: controlPlane.stageId,
        provider: provider,
        reservationKey: reservationKey,
        externalId: externalId,
        name: controlPlane.name,
        specs: options?.specs ?? controlPlane.specs,
        specsVerified: options?.specs !== undefined ? true : undefined,
        sandboxConfigId: controlPlane.sandboxConfigId,
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
      },
      { skipQueue: true },
    );
  } catch (err) {
    logError("Sandbox instance upsert mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function setSandboxInstanceSpecs(
  accountId: string,
  reservationKey: string,
  externalId: string,
  specs: SandboxSpecs,
): Promise<void> {
  try {
    await adminMutation(
      internal.sandbox.instances.setSpecs,
      {
        accountId: accountId,
        reservationKey: reservationKey,
        externalId: externalId,
        specs: specs,
      },
      { skipQueue: true },
    );
  } catch (err) {
    logError("Sandbox instance size mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// `observed`: read off the provider, not caused by a use, so the last-used clock stays.
export async function setSandboxInstanceStatus(
  accountId: string,
  reservationKey: string,
  status: SandboxInstanceStatus,
  options?: { observed?: boolean; errorMessage?: string },
): Promise<boolean> {
  try {
    const changed: boolean = await adminMutation(
      internal.sandbox.instances.setStatus,
      {
        accountId: accountId,
        reservationKey: reservationKey,
        status: status,
        observed: options?.observed === true,
        errorMessage: options?.errorMessage,
      },
      { skipQueue: true },
    );

    return changed;
  } catch (err) {
    logError("Sandbox instance status mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });

    return false;
  }
}

// Unlike the writes, a failure throws: an outage must not read as a denial.
export async function sandboxInstanceIsControllable(
  accountId: string,
  sandboxConfigId: string,
  reservationKey: string,
): Promise<boolean> {
  const controllable = await adminQuery(
    internal.sandbox.instances.isControllable,
    {
      accountId: accountId,
      sandboxConfigId: sandboxConfigId,
      reservationKey: reservationKey,
    },
  );

  return controllable === true;
}

// Totals since boot; the meter bills only the growth, so on false the caller resends them.
export async function recordSandboxBurst(
  accountId: string,
  externalId: string,
  totals: { vcpuSeconds: number; gbSeconds: number },
): Promise<boolean> {
  try {
    return await adminMutation(
      internal.sandbox.instances.recordBurst,
      {
        accountId: accountId,
        externalId: externalId,
        vcpuSeconds: totals.vcpuSeconds,
        gbSeconds: totals.gbSeconds,
      },
      { skipQueue: true },
    );
  } catch (err) {
    logError("Sandbox burst mirror failed (convex)", {
      error: err instanceof Error ? err.message : String(err),
    });

    return false;
  }
}

export async function removeSandboxInstance(
  accountId: string,
  reservationKey: string,
  externalId?: string,
): Promise<void> {
  try {
    // Built before the retries: a missing Convex config is not a blip.
    getConvexClient();
    for (const [attempt, delayMs] of REMOVE_RETRY_DELAYS_MS.entries()) {
      await Bun.sleep(delayMs);
      try {
        await adminMutation(
          internal.sandbox.instances.remove,
          {
            accountId: accountId,
            reservationKey: reservationKey,
            externalId: externalId,
          },
          { skipQueue: true },
        );

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
