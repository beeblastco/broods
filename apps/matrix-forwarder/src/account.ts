/**
 * One Matrix account: its `/sync` long-poll, its device's crypto store, and the
 * sends core routes back through it.
 *
 * The store lives under `${MATRIX_STORE_DIR}/<sha256 of user|device>/`, next to
 * the sync token. Keying it on the device, not the token, means a token that
 * rotates but keeps its device reuses its keys, and a new device starts clean.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MatrixForwardedEvent,
  MatrixSendRequest,
  MatrixTypingRequest,
} from "../../core/src/shared/matrix-wire.ts";
import { backoffDelayMs } from "../../discord-forwarder/src/backoff.ts";
import {
  logError,
  logInfo,
  logWarn,
  tokenHint,
} from "../../discord-forwarder/src/log.ts";
import { RoomCrypto } from "./crypto.ts";
import { forwardedEvent } from "./forward.ts";
import {
  MatrixClient,
  MatrixError,
  type RoomEvent,
  type SyncFilter,
  type SyncResponse,
} from "./matrix.ts";
import { sendRoomEvent } from "./send.ts";

const BACKOFF_CEILING_MS = 60_000;
/** How long an undecryptable event waits for its room key before it is dropped. */
const PENDING_TTL_MS = 5 * 60_000;
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
  /** Awaited per event, so delivery keeps timeline order. */
  onEvent: (event: MatrixForwardedEvent) => Promise<void>;
  storeDir: string;
}

interface PendingEvent {
  event: RoomEvent;
  firstSeenMs: number;
  roomId: string;
}

/** What exists once whoami answered and the store is open. */
interface Session {
  crypto: RoomCrypto;
  release: () => void;
  syncTokenPath: string;
  userId: string;
}

export class MatrixAccount {
  state: AccountState = "stopped";
  userId: string | null = null;
  private readonly client: MatrixClient;
  private readonly controller = new AbortController();
  private crypto: RoomCrypto | null = null;
  /** Room id to its members' display names. Reloaded when a sender is missing. */
  private readonly memberNames = new Map<
    string,
    Map<string, string | undefined>
  >();
  private readonly options: MatrixAccountOptions;
  private pending: PendingEvent[] = [];
  private running: Promise<void> | null = null;

  constructor(options: MatrixAccountOptions) {
    this.client = new MatrixClient(options.apiUrl, options.accessToken);
    this.options = options;
  }

  async send(request: MatrixSendRequest): Promise<string> {
    if (this.crypto === null) throw new Error("Matrix account is not started");

    return sendRoomEvent(this.client, this.crypto, request);
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
        tokenHint: this.hint(),
      });
    });
  }

  /** Resolves once the sync loop has exited and the store is closed. */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private async forwardEvent(
    session: Session,
    roomId: string,
    event: RoomEvent,
    firstSeenMs: number | null,
  ): Promise<void> {
    const encrypted = event.type === "m.room.encrypted";
    let plaintext = event;
    if (encrypted) {
      try {
        plaintext = await session.crypto.decrypt(roomId, event);
      } catch (error) {
        // Logged once, not on every retry: keys often land a sync later.
        if (firstSeenMs === null) {
          logWarn("Matrix event not decryptable yet, retrying", {
            error: error instanceof Error ? error.message : String(error),
            eventId: event.event_id,
            roomId: roomId,
            userId: session.userId,
          });
        }
        this.pending.push({
          event: event,
          firstSeenMs: firstSeenMs ?? Date.now(),
          roomId: roomId,
        });

        return;
      }
    }
    if (plaintext.type !== "m.room.message") return;

    await this.options.onEvent(
      forwardedEvent({
        encrypted: encrypted,
        event: plaintext,
        roomId: roomId,
        senderName: await this.senderName(roomId, plaintext.sender),
        userId: session.userId,
      }),
    );
  }

  /** Retries held-back events first, then this sync's timelines, in order. */
  private async forwardSync(
    session: Session,
    response: SyncResponse,
  ): Promise<void> {
    for (const item of this.pending.splice(0)) {
      if (Date.now() - item.firstSeenMs > PENDING_TTL_MS) {
        logWarn("Matrix event dropped, room key never arrived", {
          eventId: item.event.event_id,
          roomId: item.roomId,
          userId: session.userId,
        });
        continue;
      }
      await this.forwardEvent(
        session,
        item.roomId,
        item.event,
        item.firstSeenMs,
      );
    }
    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      if (room.timeline?.limited) {
        logWarn("Matrix timeline gap, some messages were not delivered", {
          roomId: roomId,
          userId: session.userId,
        });
      }
      for (const event of room.timeline?.events ?? []) {
        await this.forwardEvent(session, roomId, event, null);
      }
    }
  }

  private hint(): string {
    return tokenHint(this.options.accessToken);
  }

  /** whoami, then the device's store. Null when the account cannot or should no longer run. */
  private async open(signal: AbortSignal): Promise<Session | null> {
    const whoami = await this.client.whoami();
    // Application-service tokens have no device, and without one there are no
    // device keys to decrypt with. Retrying cannot fix that.
    if (whoami.device_id === undefined) {
      this.state = "failed";
      logError("Matrix access token has no device, account stopped", {
        tokenHint: this.hint(),
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
    try {
      await mkdir(join(storePath, "crypto"), { mode: 0o700, recursive: true });
      const crypto = await RoomCrypto.open(
        this.client,
        whoami.user_id,
        whoami.device_id,
        join(storePath, "crypto"),
      );
      this.crypto = crypto;
      this.userId = whoami.user_id;
      logInfo("Matrix account started", {
        deviceId: whoami.device_id,
        tokenHint: this.hint(),
        userId: whoami.user_id,
      });

      return {
        crypto: crypto,
        release: release,
        syncTokenPath: join(storePath, "sync-token"),
        userId: whoami.user_id,
      };
    } catch (error) {
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
            since = await readSyncToken(session.syncTokenPath);
          }
          this.state = "syncing";
          const response = await this.client.sync({
            filter: SYNC_FILTER,
            signal: signal,
            since: since,
            // The first sync returns at once and is not forwarded: starting from
            // now, not replaying room history into the agent.
            timeoutMs: since === undefined ? 0 : POLL_TIMEOUT_MS,
          });
          await session.crypto.receiveSync(response);
          if (since === undefined) {
            logInfo("Matrix backlog skipped on first sync", {
              userId: session.userId,
            });
          } else {
            await this.forwardSync(session, response);
          }
          since = response.next_batch;
          await writeFile(session.syncTokenPath, since, { mode: 0o600 });
          attempt = 0;
        } catch (error) {
          if (signal.aborted) break;
          if (
            error instanceof MatrixError &&
            error.errcode === "M_UNKNOWN_TOKEN"
          ) {
            this.state = "failed";
            logError("Matrix access token rejected, account stopped", {
              tokenHint: this.hint(),
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
            tokenHint: this.hint(),
          });
          await sleep(delayMs, signal);
        }
      }
    } finally {
      this.crypto = null;
      if (session !== null) {
        await session.crypto.close();
        session.release();
      }
      if (this.state !== "failed") this.state = "stopped";
    }
  }

  private async senderName(
    roomId: string,
    userId: string,
  ): Promise<string | undefined> {
    const cached = this.memberNames.get(roomId);
    if (cached?.has(userId)) return cached.get(userId);
    try {
      const members = await this.client.joinedMembers(roomId);
      this.memberNames.set(roomId, members);

      return members.get(userId);
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
  let resolveReleased = (): void => {};
  const released = new Promise<void>((resolve): void => {
    resolveReleased = resolve;
  });
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

/** Resolves after `ms`, or as soon as `signal` aborts. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve): void => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      (): void => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
