/**
 * Finishes snapshot images that are still building. A lambda snapshot is an
 * image build that takes minutes, so the snapshot verb records it as building
 * and this watcher asks the provider until the build lands, on whichever pod is
 * up. Started and stopped by server.ts next to the sandbox sweeper.
 */

import { providerExecutor } from "../harness/sandbox/index.ts";
import type { SandboxProvider } from "../harness/sandbox/types.ts";
import { runtime } from "./convex/runtime.ts";
import { upsertSandboxSnapshot } from "./convex/sandbox-snapshots.ts";
import { positiveIntegerEnv } from "./env.ts";
import { toErrorMessage } from "./errors.ts";
import { logWarn } from "./log.ts";

const DEFAULT_INTERVAL_SECONDS = 60;

interface BuildingSnapshot {
  accountId: string;
  name: string;
  provider: SandboxProvider;
  baseImage: string;
  externalImageId: string;
}

let watcher: ReturnType<typeof setInterval> | undefined;
let refreshing = false;

/** Starts the periodic check. No-op when it is already running. */
export function startSnapshotBuildWatcher(): void {
  if (watcher) return;
  const intervalSeconds = positiveIntegerEnv(
    "SANDBOX_SNAPSHOT_POLL_SECONDS",
    DEFAULT_INTERVAL_SECONDS,
  );
  watcher = setInterval((): void => {
    void runRefresh();
  }, intervalSeconds * 1000);
  // A pending check must not hold the process open past SIGTERM.
  watcher.unref();
}

/** Stops the periodic check, at shutdown. */
export function stopSnapshotBuildWatcher(): void {
  if (!watcher) return;
  clearInterval(watcher);
  watcher = undefined;
}

/**
 * One pass over the building snapshots: each one whose build has landed
 * is marked active or build_failed.
 * @returns the number of snapshots whose build finished
 */
export async function refreshBuildingSnapshots(): Promise<number> {
  const building = await runtime.query<BuildingSnapshot[]>(
    "listBuildingSandboxSnapshots",
    {},
  );
  let finished = 0;
  for (const snapshot of building) {
    const executor = providerExecutor({ provider: snapshot.provider });
    if (!executor.snapshotStatus) continue;
    const state = await executor
      .snapshotStatus(snapshot.externalImageId)
      .catch((error: unknown) => {
        logWarn("Snapshot build check failed", {
          accountId: snapshot.accountId,
          snapshot: snapshot.name,
          error: toErrorMessage(error),
        });

        return "building" as const;
      });
    if (state === "building") continue;
    await upsertSandboxSnapshot({
      accountId: snapshot.accountId,
      name: snapshot.name,
      provider: snapshot.provider,
      baseImage: snapshot.baseImage,
      externalImageId: snapshot.externalImageId,
      status: state,
    });
    finished += 1;
  }

  return finished;
}

// Skips a tick while the previous pass is still running.
async function runRefresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await refreshBuildingSnapshots();
  } catch (error) {
    logWarn("Snapshot build watcher pass failed", {
      error: toErrorMessage(error),
    });
  } finally {
    refreshing = false;
  }
}
