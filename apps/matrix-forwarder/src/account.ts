import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MatrixSendRequest,
  MatrixTypingRequest,
} from "../../core/src/shared/matrix-wire.ts";
import { backoffDelayMs } from "../../discord-forwarder/src/backoff.ts";
import type { ForwardTarget } from "../../discord-forwarder/src/forward.ts";
import {
  logError,
  logInfo,
  logWarn,
  tokenHint,
} from "../../discord-forwarder/src/log.ts";
import { RoomCrypto } from "./crypto.ts";
import { forwardedEvent, forwardRoomEvent, isOwnMessage } from "./forward.ts";
import {
  MatrixClient,
  MatrixError,
  type SyncFilter,
  type SyncResponse,
} from "./matrix.ts";
import { Outbox, type OutboxEntry, type OutboxEvent } from "./outbox.ts";
import { sendRoomEvent } from "./send.ts";

const BACKOFF_CEILING_MS = 60_000;
const MEMBER_NAMES_TTL_MS = 5 * 60_000;
const POLL_TIMEOUT_MS = 30_000;
const SYNC_FILTER: SyncFilter = {
  account_data: { types: [] },
  presence: { types: [] },
  room: {
    account_data: { types: [] },
    ephemeral: { types: [] },
    state: { types: [] },
    timeline: { limit: 50, types: ["m.room.encrypted", "m.room.message"] },
  },
};

// Process-wide: a re-pointed account can open a device's store before the old one closed it.
const storeHolders = new Map<string, Promise<void>>();

export type AccountState =
  | "backoff"
  | "failed"
  | "starting"
  | "stopped"
  | "syncing";

export interface MatrixAccountOptions {
  accessToken: string;
  apiUrl: string;
  storeDir: string;
  targets: () => readonly ForwardTarget[];
  webhookTimeoutMs?: number;
}

interface Session {
  crypto: RoomCrypto;
  outbox: Outbox;
  release: () => void;
  syncTokenPath: string;
  userId: string;
}

export class MatrixAccount {
  state: AccountState = "stopped";
  userId: string | null = null;
  private readonly client: MatrixClient;
  private readonly controller = new AbortController();
  private readonly memberNames = new Map<
    string,
    { expiresMs: number; names: Map<string, string | undefined> }
  >();
  private readonly options: MatrixAccountOptions;
  private running: Promise<void> | null = null;
  private session: Session | null = null;

  constructor(options: MatrixAccountOptions) {
    this.client = new MatrixClient(options.apiUrl, options.accessToken);
    this.options = options;
  }

  async send(request: MatrixSendRequest): Promise<string> {
    if (this.session === null) throw new Error("Matrix account is not started");

    return sendRoomEvent(this.client, this.session.crypto, request);
  }

  async setTyping(request: MatrixTypingRequest): Promise<void> {
    if (this.userId === null) throw new Error("Matrix account is not started");
    await this.client.setTyping(request.roomId, this.userId, request.typing);
  }

  start(): void {
    if (this.running !== null) return;
    this.state = "starting";
    this.running = this.run().catch((error: unknown): void => {
      this.state = "failed";
      logError("Matrix account stopped unexpectedly", {
        error: error instanceof Error ? error.message : String(error),
        tokenHint: tokenHint(this.options.accessToken),
      });
    });
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  // A waiting event holds back the later ones on its targets, or in its room while its key is
  // missing, so no target sees a newer message before an older one.
  private async drain(session: Session): Promise<number> {
    const signal = this.controller.signal;
    for (const dropped of session.outbox.prune()) {
      this.logDropped(session, dropped, dropped.reason);
    }
    const failing = new Map<string, number>();
    const keyWait = new Map<string, number>();
    let wakeAtMs = Infinity;
    for (const entry of session.outbox.entries()) {
      if (signal.aborted) break;
      const { eventId, roomId } = entry;
      const owed = owedTargets(this.options.targets(), entry.targetsLeft);
      if (owed.length === 0) {
        if (entry.targetsLeft !== null) {
          this.logDropped(session, entry, "removed");
        }
        session.outbox.settle(eventId);
        continue;
      }
      if (entry.nextAttemptMs > Date.now()) {
        wakeAtMs = Math.min(wakeAtMs, entry.nextAttemptMs);
        holdBehind(entry, owed, failing, keyWait);
        continue;
      }
      const tryNow = owed.filter(
        (target): boolean => !failing.has(target.webhookUrl),
      );
      if (keyWait.has(roomId) || tryNow.length === 0) continue;
      const event = session.outbox.event(eventId);
      if (event === null) continue;
      const encrypted = event.type === "m.room.encrypted";
      let plaintext = event;
      if (encrypted) {
        try {
          plaintext = await session.crypto.decrypt(roomId, event);
        } catch (error) {
          if (entry.attempts === 0) {
            logWarn("Matrix event not decryptable yet, retrying", {
              error: error instanceof Error ? error.message : String(error),
              eventId: eventId,
              roomId: roomId,
              userId: session.userId,
            });
          }
          const retryAtMs =
            Date.now() + backoffDelayMs(entry.attempts, BACKOFF_CEILING_MS);
          session.outbox.retry(
            eventId,
            entry.attempts + 1,
            retryAtMs,
            entry.targetsLeft,
          );
          keyWait.set(roomId, retryAtMs);
          wakeAtMs = Math.min(wakeAtMs, retryAtMs);
          continue;
        }
      }
      if (
        plaintext.type !== "m.room.message" ||
        isOwnMessage(plaintext.content)
      ) {
        session.outbox.settle(eventId);
        continue;
      }
      const left = await forwardRoomEvent(
        forwardedEvent({
          encrypted: encrypted,
          event: plaintext,
          roomId: roomId,
          senderName: await this.senderName(roomId, plaintext.sender),
          userId: session.userId,
        }),
        this.options.accessToken,
        tryNow,
        this.options.webhookTimeoutMs,
      );
      const retryAtMs =
        Date.now() + backoffDelayMs(entry.attempts, BACKOFF_CEILING_MS);
      for (const webhookUrl of left) failing.set(webhookUrl, retryAtMs);
      const pending = owed.filter((target): boolean =>
        failing.has(target.webhookUrl),
      );
      if (pending.length === 0) {
        session.outbox.settle(eventId);
        continue;
      }
      const nextAttemptMs = Math.min(
        ...pending.map(
          (target): number => failing.get(target.webhookUrl) ?? retryAtMs,
        ),
      );
      session.outbox.retry(eventId, entry.attempts + 1, nextAttemptMs, [
        ...new Set(pending.map((target): string => target.agentId)),
      ]);
      wakeAtMs = Math.min(wakeAtMs, nextAttemptMs);
    }

    return wakeAtMs;
  }

  private keep(session: Session, response: SyncResponse): void {
    const rooms = Object.entries(response.rooms?.join ?? {});
    for (const [roomId, room] of rooms) {
      if (room.timeline?.limited) {
        logWarn("Matrix timeline gap, some messages were not delivered", {
          roomId: roomId,
          userId: session.userId,
        });
      }
    }
    session.outbox.add(
      rooms.flatMap(([roomId, room]): OutboxEvent[] =>
        (room.timeline?.events ?? []).map((event): OutboxEvent => ({
          event: event,
          roomId: roomId,
        })),
      ),
    );
  }

  private logDropped(
    session: Session,
    entry: OutboxEntry,
    reason: string,
  ): void {
    logError("Matrix event dropped from the outbox", {
      agentIds: (
        entry.targetsLeft ??
        this.options.targets().map((target): string => target.agentId)
      ).join(","),
      attempts: entry.attempts,
      eventId: entry.eventId,
      firstSeen: new Date(entry.firstSeenMs).toISOString(),
      reason: reason,
      roomId: entry.roomId,
      userId: session.userId,
    });
  }

  private async open(signal: AbortSignal): Promise<Session | null> {
    const whoami = await this.client.whoami();
    // Application-service tokens have no device, so no keys to decrypt with: retrying cannot help.
    if (whoami.device_id === undefined) {
      this.state = "failed";
      logError("Matrix access token has no device, account stopped", {
        tokenHint: tokenHint(this.options.accessToken),
        userId: whoami.user_id,
      });

      return null;
    }
    // Per device, not per token: a rotated token keeps its keys, a new device starts clean.
    const storePath = join(
      this.options.storeDir,
      createHash("sha256")
        .update(`${whoami.user_id}|${whoami.device_id}`)
        .digest("hex"),
    );
    const release = await claimStore(storePath, signal, whoami.user_id);
    if (release === null) return null;
    let outbox: Outbox | undefined;
    try {
      await mkdir(join(storePath, "crypto"), { mode: 0o700, recursive: true });
      outbox = new Outbox(join(storePath, "outbox.sqlite"));
      const crypto = await RoomCrypto.open(
        this.client,
        whoami.user_id,
        whoami.device_id,
        join(storePath, "crypto"),
      );
      this.userId = whoami.user_id;
      logInfo("Matrix account started", {
        deviceId: whoami.device_id,
        tokenHint: tokenHint(this.options.accessToken),
        userId: whoami.user_id,
      });

      return {
        crypto: crypto,
        outbox: outbox,
        release: release,
        syncTokenPath: join(storePath, "sync-token"),
        userId: whoami.user_id,
      };
    } catch (error) {
      outbox?.close();
      release();
      throw error;
    }
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    let attempt = 0;
    let session: Session | null = null;
    let since: string | undefined;
    try {
      while (!signal.aborted) {
        try {
          if (session === null) {
            session = await this.open(signal);
            if (session === null) break;
            this.session = session;
            since = await readSyncToken(session.syncTokenPath);
          }
          // Drained before the sync, so held events go out even while the homeserver is down.
          const wakeAtMs = await this.drain(session);
          this.state = "syncing";
          const response = await this.client.sync({
            filter: SYNC_FILTER,
            signal: signal,
            since: since,
            timeoutMs:
              since === undefined
                ? 0
                : Math.max(0, Math.min(POLL_TIMEOUT_MS, wakeAtMs - Date.now())),
          });
          await session.crypto.receiveSync(response);
          if (since === undefined) {
            logInfo("Matrix backlog skipped on first sync", {
              userId: session.userId,
            });
          } else {
            this.keep(session, response);
          }
          // Safe before delivery: this sync's events are already in the outbox.
          since = response.next_batch;
          await writeSyncToken(session.syncTokenPath, since);
          attempt = 0;
        } catch (error) {
          if (signal.aborted) break;
          if (
            error instanceof MatrixError &&
            error.errcode === "M_UNKNOWN_TOKEN"
          ) {
            this.state = "failed";
            logError("Matrix access token rejected, account stopped", {
              tokenHint: tokenHint(this.options.accessToken),
              userId: this.userId ?? undefined,
            });
            break;
          }
          const delayMs =
            error instanceof MatrixError && error.retryAfterMs !== undefined
              ? error.retryAfterMs
              : backoffDelayMs(attempt, BACKOFF_CEILING_MS);
          attempt += 1;
          this.state = "backoff";
          logWarn("Matrix sync failed, retrying", {
            delayMs: delayMs,
            error: error instanceof Error ? error.message : String(error),
            tokenHint: tokenHint(this.options.accessToken),
          });
          await sleep(delayMs, signal);
        }
      }
    } finally {
      this.session = null;
      if (this.state !== "failed") this.state = "stopped";
      if (session !== null) {
        // Released even if close throws, or the device's next account waits in claimStore forever.
        try {
          await session.crypto.close();
        } finally {
          session.outbox.close();
          session.release();
        }
      }
    }
  }

  private async senderName(
    roomId: string,
    userId: string,
  ): Promise<string | undefined> {
    const cached = this.memberNames.get(roomId);
    if (cached?.names.has(userId) && cached.expiresMs > Date.now()) {
      return cached.names.get(userId);
    }
    try {
      const names = await this.client.joinedMembers(roomId);
      if (!names.has(userId)) names.set(userId, undefined);
      this.memberNames.set(roomId, {
        expiresMs: Date.now() + MEMBER_NAMES_TTL_MS,
        names: names,
      });

      return names.get(userId);
    } catch (error) {
      logWarn("Matrix member lookup failed", {
        error: error instanceof Error ? error.message : String(error),
        roomId: roomId,
      });

      return undefined;
    }
  }
}

async function claimStore(
  storePath: string,
  signal: AbortSignal,
  userId: string,
): Promise<(() => void) | null> {
  const previous = storeHolders.get(storePath);
  const { promise: released, resolve: resolveReleased } =
    Promise.withResolvers<void>();
  const held = (previous ?? Promise.resolve()).then(
    (): Promise<void> => released,
  );
  storeHolders.set(storePath, held);
  const release = (): void => {
    resolveReleased();
    if (storeHolders.get(storePath) === held) storeHolders.delete(storePath);
  };
  if (previous === undefined) return release;

  logWarn("Matrix crypto store in use, waiting for it to close", {
    userId: userId,
  });
  const aborted = await Promise.race([
    previous.then((): boolean => false),
    new Promise<boolean>((resolve): void => {
      if (signal.aborted) resolve(true);
      signal.addEventListener("abort", (): void => resolve(true), {
        once: true,
      });
    }),
  ]);
  if (!aborted) return release;
  release();

  return null;
}

function holdBehind(
  entry: OutboxEntry,
  owed: readonly ForwardTarget[],
  failing: Map<string, number>,
  keyWait: Map<string, number>,
): void {
  const [holds, keys] =
    entry.targetsLeft === null
      ? [keyWait, [entry.roomId]]
      : [failing, owed.map((target): string => target.webhookUrl)];
  for (const key of keys) {
    if (!holds.has(key)) holds.set(key, entry.nextAttemptMs);
  }
}

function owedTargets(
  targets: readonly ForwardTarget[],
  agentIds: readonly string[] | null,
): ForwardTarget[] {
  return targets.filter(
    (target): boolean => agentIds === null || agentIds.includes(target.agentId),
  );
}

async function readSyncToken(path: string): Promise<string | undefined> {
  try {
    const token = (await readFile(path, "utf8")).trim();

    return token === "" ? undefined : token;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

// `once` alone would leave a listener on the account's signal for every retry the timer wins.
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const abort = (): void => {
    clearTimeout(timer);
    resolve();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await promise;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function writeSyncToken(path: string, token: string): Promise<void> {
  const pending = `${path}.pending`;
  await writeFile(pending, token, { mode: 0o600 });

  await rename(pending, path);
}
