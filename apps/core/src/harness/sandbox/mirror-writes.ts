import {
  removeSandboxInstance,
  type SandboxInstanceUpsertOptions,
  upsertSandboxInstance,
} from "../../shared/convex/sandbox-instances.ts";
import type { SandboxProvider } from "../../shared/domain/sandbox-config.ts";
import { waitUntil } from "../../shared/in-flight.ts";
import { logWarn } from "../../shared/log.ts";
import { DEFAULT_IDLE_TIMEOUT_SECONDS } from "../../shared/sandbox.ts";
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
// A Convex write costs the same CPU whatever it changes, so an unchanged refresh inside this
// window is not sent. The meter reads a machine as running until its last refresh plus its idle
// timeout, so the window is also at most this part of that timeout.
const MIRROR_REFRESH_EVERY_MS = 60_000;
const MIRROR_REFRESH_IDLE_PART = 15;

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

interface Lane {
  rowKey: string;
  writes: MirrorWrite[];
  sending: boolean;
}

// Parallel writes on one account conflict on its shared usage rows in Convex and fail, so an
// account sends one write at a time. `urgent` rows hold a status or a removal, which a caller
// waits for: they send first.
interface AccountSender {
  busy: boolean;
  urgent: Set<Lane>;
  ready: Set<Lane>;
  idle: PromiseWithResolvers<void>;
}

const lanes = new Map<string, Lane>();
const senders = new Map<string, AccountSender>();
// Each row's last upsert queued, oldest first.
const refreshed = new Map<string, { signature: string; at: number }>();
let lastWarnAt = 0;

// One lane per row (its reservation key; an ephemeral row's key is its sandbox id): a row's
// writes land in the order queued, and a write of the same kind to the same machine as the lane's
// last pending write takes its place, so a backlog holds the latest only. An account's lanes
// take turns on its sender, so overload makes refreshes staler, never a growing queue.
export function queueMirrorWrite(
  accountId: string,
  rowKey: string,
  write: {
    kind: Exclude<MirrorWriteKind, "remove" | "upsert">;
    externalId?: string;
    send: () => Promise<unknown>;
  },
): Promise<void> {
  return enqueue(accountId, rowKey, {
    kind: write.kind,
    externalId: write.externalId,
    queuedAt: Date.now(),
    send: write.send,
    done: Promise.withResolvers<void>(),
  });
}

// Taking a pending upsert's place keeps the run fields the newer one lacks.
export function queueMirrorUpsert(upsert: MirrorUpsert): Promise<void> {
  if (!upsert.controlPlane) return Promise.resolve();
  const now = Date.now();
  for (const [rowKey, sent] of refreshed) {
    if (now - sent.at < MIRROR_REFRESH_EVERY_MS) break;
    refreshed.delete(rowKey);
  }
  const signature = JSON.stringify(upsert);
  const last = refreshed.get(upsert.reservationKey);
  const idleSeconds =
    upsert.controlPlane.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const windowMs = Math.min(
    MIRROR_REFRESH_EVERY_MS,
    (idleSeconds * 1000) / MIRROR_REFRESH_IDLE_PART,
  );
  if (last?.signature === signature && now - last.at < windowMs) {
    return Promise.resolve();
  }
  refreshed.delete(upsert.reservationKey);
  refreshed.set(upsert.reservationKey, { signature: signature, at: now });

  return enqueue(upsert.controlPlane.accountId, upsert.reservationKey, {
    kind: "upsert",
    externalId: upsert.externalId,
    queuedAt: Date.now(),
    send: (): Promise<void> => sendUpsert(upsert),
    upsert: upsert,
    done: Promise.withResolvers<void>(),
  });
}

// Lands after every write queued before it. `externalId` names the only machine it may remove.
export function queueMirrorRemove(
  accountId: string,
  reservationKey: string,
  externalId?: string,
): Promise<void> {
  return enqueue(accountId, reservationKey, {
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
    pending += lane.writes.length;
    for (const write of lane.writes) oldest = Math.min(oldest, write.queuedAt);
  }

  return { rows: lanes.size, pending: pending, oldestPendingMs: now - oldest };
}

function enqueue(
  accountId: string,
  rowKey: string,
  write: MirrorWrite,
): Promise<void> {
  const lane = lanes.get(rowKey) ?? {
    rowKey: rowKey,
    writes: [],
    sending: false,
  };
  lanes.set(rowKey, lane);
  // The row is about to change under its last refresh, so the next one must be sent.
  if (write.kind === "remove" || write.kind === "status") {
    refreshed.delete(rowKey);
  }
  const landed = place(lane, write);
  let sender = senders.get(accountId);
  if (!sender) {
    sender = {
      busy: false,
      urgent: new Set(),
      ready: new Set(),
      idle: Promise.withResolvers<void>(),
    };
    senders.set(accountId, sender);
    waitUntil(sender.idle.promise);
  }
  if (!lane.sending) park(sender, lane);
  pump(accountId, sender);

  return landed;
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

function mergedUpsert(older: MirrorUpsert, newer: MirrorUpsert): MirrorUpsert {
  const was = { ...older.metadata, ...older.options };
  const now = { ...newer.metadata, ...newer.options };

  return {
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
}

// Keeps a lane's place in line; a lane that gains a status or removal moves to the urgent set.
function park(sender: AccountSender, lane: Lane): void {
  if (
    lane.writes.some(
      (write) => write.kind === "remove" || write.kind === "status",
    )
  ) {
    sender.ready.delete(lane);
    sender.urgent.add(lane);
  } else if (!sender.urgent.has(lane)) {
    sender.ready.add(lane);
  }
}

function place(lane: Lane, write: MirrorWrite): Promise<void> {
  const last = lane.writes.at(-1);
  if (last?.kind !== write.kind || last.externalId !== write.externalId) {
    lane.writes.push(write);

    return write.done.promise;
  }
  if (last.upsert && write.upsert) {
    const merged = mergedUpsert(last.upsert, write.upsert);
    last.upsert = merged;
    last.send = (): Promise<void> => sendUpsert(merged);
  } else {
    last.send = write.send;
  }

  return last.done.promise;
}

function pump(accountId: string, sender: AccountSender): void {
  if (sender.busy) return;
  const lane: Lane | undefined =
    sender.urgent.values().next().value ?? sender.ready.values().next().value;
  const write = lane?.writes.shift();
  if (!lane || !write) {
    senders.delete(accountId);
    sender.idle.resolve();

    return;
  }
  sender.urgent.delete(lane);
  sender.ready.delete(lane);
  sender.busy = true;
  lane.sending = true;
  void land(lane.rowKey, write).then((): void => {
    write.done.resolve();
    sender.busy = false;
    lane.sending = false;
    if (lane.writes.length > 0) park(sender, lane);
    else lanes.delete(lane.rowKey);
    pump(accountId, sender);
  });
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
