/**
 * One Matrix account: its `/sync` long-poll, its device's crypto store, and the
 * sends core routes back through it.
 *
 * The store lives under `${MATRIX_STORE_DIR}/<sha256 of user|device>/`, next to
 * the sync token and the outbox. Keying it on the device, not the token, means
 * a token that rotates but keeps its device reuses its keys, and a new device
 * starts clean.
 */

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
import { Outbox, type OutboxEvent } from "./outbox.ts";
import { sendRoomEvent } from "./send.ts";

const BACKOFF_CEILING_MS = 60_000;
/** How long a room's display names are used before they are fetched again. */
const MEMBER_NAMES_TTL_MS = 5 * 60_000;
const POLL_TIMEOUT_MS = 30_000;
// Every joined room, messages only. State, receipts and presence would wake the
// long-poll for nothing core reads.
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

/**
 * Store path to a promise that settles once its current holder has closed it.
 * Process-wide because two accounts can name one device: a re-pointed account
 * starts before the old one has finished stopping.
 */
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
  /**
   * The webhooks to deliver to, read at each delivery: reconcile replaces them
   * while the account runs.
   */
  targets: () => readonly ForwardTarget[];
}

/** What exists once whoami answered and the store is open. */
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
  /**
   * Room id to its members' display names, and until when they hold. Reloaded
   * early when a sender is missing; the expiry lets a rename show up.
   */
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

  /** Resolves once the sync loop has exited and the store is closed. */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  /**
   * Tries every outbox event that is due, oldest first, on the targets it is
   * still owed. A target that fails is not tried again in the same pass: the
   * events behind it wait for its retry, so an outage costs one webhook timeout
   * per pass, not one per event. Stops between events once the account is
   * stopping: each delivery can take the webhook timeout, and shutdown has a
   * grace period to fit in. What it did not reach stays in the outbox.
   */
  private async drain(session: Session): Promise<void> {
    const signal = this.controller.signal;
    for (const dropped of session.outbox.prune()) {
      logError("Matrix event dropped from the outbox", {
        agentIds: owedTargets(this.options.targets(), dropped.targetsLeft)
          .map((target): string => target.agentId)
          .join(","),
        attempts: dropped.attempts,
        eventId: dropped.eventId,
        firstSeen: new Date(dropped.firstSeenMs).toISOString(),
        reason: dropped.expired ? "expired" : "overflow",
        roomId: dropped.roomId,
        userId: session.userId,
      });
    }
    /** Webhook URL to when it is tried again, for each target that failed this pass. */
    const failing = new Map<string, number>();
    for (const entry of session.outbox.due()) {
      if (signal.aborted) return;
      const { event, eventId, roomId } = entry;
      const owed = owedTargets(this.options.targets(), entry.targetsLeft);
      // A removed target is no longer owed anything.
      if (owed.length === 0) {
        session.outbox.settle(eventId);
        continue;
      }
      const tryNow = owed.filter(
        (target): boolean => !failing.has(target.webhookUrl),
      );
      if (tryNow.length > 0) {
        const encrypted = event.type === "m.room.encrypted";
        let plaintext = event;
        if (encrypted) {
          try {
            plaintext = await session.crypto.decrypt(roomId, event);
          } catch (error) {
            // Logged once, not on every retry: keys often land a sync later.
            if (entry.attempts === 0) {
              logWarn("Matrix event not decryptable yet, retrying", {
                error: error instanceof Error ? error.message : String(error),
                eventId: eventId,
                roomId: roomId,
                userId: session.userId,
              });
            }
            session.outbox.retry(
              eventId,
              entry.attempts + 1,
              Date.now() + backoffDelayMs(entry.attempts, BACKOFF_CEILING_MS),
              entry.targetsLeft,
            );
            continue;
          }
        }
        // The agent's own replies arrive on the next sync like any other
        // message, and core would only discard them again.
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
        );
        const retryAtMs =
          Date.now() + backoffDelayMs(entry.attempts, BACKOFF_CEILING_MS);
        for (const webhookUrl of left) failing.set(webhookUrl, retryAtMs);
      }
      // Still owed: the targets that failed, now or earlier in this pass. The
      // event is tried again when the first of them is.
      const pending = owed.flatMap((target): Array<[string, number]> => {
        const retryAtMs = failing.get(target.webhookUrl);

        return retryAtMs === undefined ? [] : [[target.webhookUrl, retryAtMs]];
      });
      if (pending.length === 0) {
        session.outbox.settle(eventId);
        continue;
      }
      session.outbox.retry(
        eventId,
        entry.attempts + (tryNow.length > 0 ? 1 : 0),
        Math.min(...pending.map(([, retryAtMs]): number => retryAtMs)),
        pending.map(([webhookUrl]): string => webhookUrl),
      );
    }
  }

  /** Puts every timeline event of a sync in the outbox, in timeline order. */
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

  /** whoami, then the device's store. Null when the account cannot or should no longer run. */
  private async open(signal: AbortSignal): Promise<Session | null> {
    const whoami = await this.client.whoami();
    // Application-service tokens have no device, and without one there are no
    // device keys to decrypt with. Retrying cannot fix that.
    if (whoami.device_id === undefined) {
      this.state = "failed";
      logError("Matrix access token has no device, account stopped", {
        tokenHint: tokenHint(this.options.accessToken),
        userId: whoami.user_id,
      });

      return null;
    }
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
          this.state = "syncing";
          // A held event is retried when it is due, not when the next message
          // happens to end the long-poll.
          const nextAttemptMs = session.outbox.nextAttemptMs() ?? Infinity;
          const response = await this.client.sync({
            filter: SYNC_FILTER,
            signal: signal,
            since: since,
            // The first sync returns at once and is not forwarded: starting from
            // now, not replaying room history into the agent.
            timeoutMs:
              since === undefined
                ? 0
                : Math.max(
                    0,
                    Math.min(POLL_TIMEOUT_MS, nextAttemptMs - Date.now()),
                  ),
          });
          await session.crypto.receiveSync(response);
          if (since === undefined) {
            logInfo("Matrix backlog skipped on first sync", {
              userId: session.userId,
            });
          } else {
            this.keep(session, response);
          }
          // Stored before anything is delivered: what this sync served is in
          // the outbox now, and a restart takes it from there.
          since = response.next_batch;
          await writeSyncToken(session.syncTokenPath, since);
          attempt = 0;
          await this.drain(session);
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
        // Released even when the close fails, or the next account for this
        // device waits in claimStore for a holder that is already gone.
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
      // Costs only the name, so the message still goes.
      logWarn("Matrix member lookup failed", {
        error: error instanceof Error ? error.message : String(error),
        roomId: roomId,
      });

      return undefined;
    }
  }
}

/**
 * Waits for an earlier holder of `storePath` to close it, then takes it.
 * Returns the release function, or null when `signal` aborted first.
 */
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

/** The current targets an event is still owed: all of them before its first try. */
function owedTargets(
  targets: readonly ForwardTarget[],
  targetsLeft: readonly string[] | null,
): ForwardTarget[] {
  return targets.filter(
    (target): boolean =>
      targetsLeft === null || targetsLeft.includes(target.webhookUrl),
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

/**
 * Resolves after `ms`, or as soon as `signal` aborts. The listener is removed
 * either way: `once` alone would leave one behind on the account's signal for
 * every retry the timer won, which is every retry that is not a shutdown.
 */
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

/**
 * Renamed over the old token rather than written in place. A process that dies
 * mid-write would otherwise leave a truncated token, and the next sync with it
 * fails until someone deletes the file by hand.
 */
async function writeSyncToken(path: string, token: string): Promise<void> {
  const pending = `${path}.pending`;
  await writeFile(pending, token, { mode: 0o600 });

  await rename(pending, path);
}
