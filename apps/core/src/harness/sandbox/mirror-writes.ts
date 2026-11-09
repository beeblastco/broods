import {
  removeSandboxInstance,
  type SandboxInstanceUpsertOptions,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import type { SandboxProvider } from "../../shared/domain/sandbox-config.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { logWarn } from "../../shared/log.ts";
import type {
  SandboxControlPlane,
  SandboxRunMetadata,
} from "../../shared/sandbox-sizes.ts";

// A hung mutation frees its row's lane after this; it may still land, which the
// reservation check in `sandbox.instances.upsert` makes safe for a released machine.
export const MIRROR_WRITE_TIMEOUT_MS = 10_000;
const MIRROR_WRITE_SLOW_MS = 2_000;
// One warning per window, so a slow Convex does not log once per row.
const MIRROR_WARN_EVERY_MS = 30_000;

export type MirrorWriteKind =
  | "burst"
  | "remove"
  | "specs"
  | "status"
  | "upsert";

export interface MirrorUpsert {
  controlPlane: SandboxControlPlane | undefined;
  provider: SandboxProvider;
  reservationKey: string;
  externalId: string;
  metadata?: SandboxRunMetadata;
  options?: SandboxInstanceUpsertOptions;
}

export interface MirrorQueueStats {
  rows: number;
  pending: number;
  oldestPendingMs: number;
}

interface MirrorWrite {
  kind: MirrorWriteKind;
  externalId?: string;
  queuedAt: number;
  send: () => Promise<unknown>;
  upsert?: MirrorUpsert;
  done: PromiseWithResolvers<void>;
}

const lanes = new Map<string, MirrorWrite[]>();
let lastWarnAt = 0;

// One lane per row (its reservation key; an ephemeral row's key is its sandbox id): writes to
// one row land in order, rows run in parallel. A lane holds one write in flight and at most one
// pending per kind and machine, so memory follows rows, not writes.
export function queueMirrorWrite(
  rowKey: string,
  write: {
    kind: Exclude<MirrorWriteKind, "remove" | "upsert">;
    externalId?: string;
    send: () => Promise<unknown>;
  },
): Promise<void> {
  return enqueue(rowKey, {
    kind: write.kind,
    externalId: write.externalId,
    queuedAt: Date.now(),
    send: write.send,
    done: Promise.withResolvers<void>(),
  });
}

// Replaces the row's pending write to the same machine, keeping run fields the newer one lacks.
export function queueMirrorUpsert(upsert: MirrorUpsert): Promise<void> {
  if (!upsert.controlPlane) return Promise.resolve();

  return enqueue(upsert.reservationKey, {
    kind: "upsert",
    externalId: upsert.externalId,
    queuedAt: Date.now(),
    send: (): Promise<void> => sendUpsert(upsert),
    upsert: upsert,
    done: Promise.withResolvers<void>(),
  });
}

// Drops the row's pending upsert and status writes for the machine it removes (all of them
// without `externalId`). Nothing queued before it lands after it.
export function queueMirrorRemove(
  accountId: string,
  reservationKey: string,
  externalId?: string,
): Promise<void> {
  return enqueue(reservationKey, {
    kind: "remove",
    externalId: externalId,
    queuedAt: Date.now(),
    send: (): Promise<void> =>
      removeSandboxInstance(accountId, reservationKey, externalId),
    done: Promise.withResolvers<void>(),
  });
}

export function mirrorQueueStats(): MirrorQueueStats {
  const now = Date.now();
  let pending = 0;
  let oldest = now;
  for (const lane of lanes.values()) {
    pending += lane.length;
    for (const write of lane) oldest = Math.min(oldest, write.queuedAt);
  }

  return { rows: lanes.size, pending: pending, oldestPendingMs: now - oldest };
}

function coalesce(lane: MirrorWrite[], write: MirrorWrite): MirrorWrite[] {
  const kept: MirrorWrite[] = [];
  let next = write;
  for (const queued of lane) {
    if (write.kind === "remove" && removes(write, queued)) {
      void write.done.promise.then(queued.done.resolve);
    } else if (
      queued.kind === write.kind &&
      queued.externalId === write.externalId
    ) {
      next =
        write.upsert && queued.upsert
          ? mergedUpsert(queued.upsert, write.upsert)
          : write;
      next.queuedAt = queued.queuedAt;
      void next.done.promise.then(queued.done.resolve);
    } else {
      kept.push(queued);
    }
  }
  if (next !== write) void next.done.promise.then(write.done.resolve);

  return [...kept, next];
}

async function drain(rowKey: string, lane: MirrorWrite[]): Promise<void> {
  for (let write = lane.shift(); write; write = lanes.get(rowKey)?.shift()) {
    await land(rowKey, write);
    write.done.resolve();
  }
  lanes.delete(rowKey);
}

function enqueue(rowKey: string, write: MirrorWrite): Promise<void> {
  const lane = lanes.get(rowKey);
  if (lane) {
    lanes.set(rowKey, coalesce(lane, write));
  } else {
    const started: MirrorWrite[] = [write];
    lanes.set(rowKey, started);
    waitUntil(drain(rowKey, started));
  }

  return write.done.promise;
}

async function land(rowKey: string, write: MirrorWrite): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve): void => {
    timer = setTimeout((): void => resolve(true), MIRROR_WRITE_TIMEOUT_MS);
  });
  // The executor turns a sender's synchronous throw into a rejection, so the lane moves on.
  const sent = new Promise<unknown>((resolve): void =>
    resolve(write.send()),
  ).then(
    (): boolean => false,
    (): boolean => false,
  );
  const stalled = await Promise.race([sent, timedOut]);
  clearTimeout(timer);
  const now = Date.now();
  const waitedMs = now - write.queuedAt;
  if (
    (stalled || waitedMs > MIRROR_WRITE_SLOW_MS) &&
    now - lastWarnAt >= MIRROR_WARN_EVERY_MS
  ) {
    lastWarnAt = now;
    logWarn(
      stalled ? "Sandbox mirror write timed out" : "Sandbox mirror write slow",
      {
        rowKey: rowKey,
        kind: write.kind,
        waitedMs: waitedMs,
        ...mirrorQueueStats(),
      },
    );
  }
}

function mergedUpsert(older: MirrorUpsert, newer: MirrorUpsert): MirrorWrite {
  const was = { ...older.metadata, ...older.options };
  const now = { ...newer.metadata, ...newer.options };
  const merged: MirrorUpsert = {
    ...newer,
    metadata: {
      traceId: now.traceId ?? was.traceId,
      taskId: now.taskId ?? was.taskId,
      agentId: now.agentId ?? was.agentId,
      conversationKey: now.conversationKey ?? was.conversationKey,
      workspaceName: now.workspaceName ?? was.workspaceName,
      workspaceId: now.workspaceId ?? was.workspaceId,
    },
    options: {
      ephemeral: now.ephemeral ?? was.ephemeral,
      logStream: now.logStream ?? was.logStream,
      specs: now.specs ?? was.specs,
    },
  };

  return {
    kind: "upsert",
    externalId: merged.externalId,
    queuedAt: Date.now(),
    send: (): Promise<void> => sendUpsert(merged),
    upsert: merged,
    done: Promise.withResolvers<void>(),
  };
}

// Burst and size writes still change what the removal bills, so they land first.
function removes(removal: MirrorWrite, queued: MirrorWrite): boolean {
  if (queued.kind !== "upsert" && queued.kind !== "status") return false;

  return (
    removal.externalId === undefined || queued.externalId === removal.externalId
  );
}

function sendUpsert(upsert: MirrorUpsert): Promise<void> {
  return upsertSandboxInstance(
    upsert.controlPlane,
    upsert.provider,
    upsert.reservationKey,
    upsert.externalId,
    upsert.metadata,
    upsert.options,
  );
}
