import { providerExecutor } from "../harness/sandbox/index.ts";
import { runtime } from "./convex/runtime.ts";
import { upsertSandboxSnapshot } from "./convex/sandbox-snapshots.ts";
import { positiveIntegerEnv } from "./env.ts";
import { toErrorMessage } from "./errors.ts";
import { logWarn } from "./log.ts";

const DEFAULT_INTERVAL_SECONDS = 60;

let watcher: ReturnType<typeof setInterval> | undefined;
let refreshing = false;

export function startSnapshotBuildWatcher(): void {
  if (watcher) return;
  const intervalSeconds = positiveIntegerEnv(
    "SANDBOX_SNAPSHOT_POLL_SECONDS",
    DEFAULT_INTERVAL_SECONDS,
  );
  watcher = setInterval((): void => {
    void runRefresh();
  }, intervalSeconds * 1000);
  watcher.unref();
}

export function stopSnapshotBuildWatcher(): void {
  if (!watcher) return;
  clearInterval(watcher);
  watcher = undefined;
}

export async function refreshBuildingSnapshots(): Promise<number> {
  const building = await runtime.query("listBuildingSandboxSnapshots", {});
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
    const recorded = await upsertSandboxSnapshot({
      accountId: snapshot.accountId,
      scope: snapshot.scope,
      name: snapshot.name,
      provider: snapshot.provider,
      baseImage: snapshot.baseImage,
      externalImageId: snapshot.externalImageId,
      status: state,
    }).then(
      () => true,
      (error: unknown) => {
        logWarn("Snapshot build status write failed", {
          accountId: snapshot.accountId,
          snapshot: snapshot.name,
          error: toErrorMessage(error),
        });

        return false;
      },
    );
    if (recorded) finished += 1;
  }

  return finished;
}

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
