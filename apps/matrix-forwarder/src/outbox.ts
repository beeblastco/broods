/**
 * An account's durable outbox. Every timeline event of a forwarded sync lands
 * here before the stored sync token moves past it, and leaves once each target
 * took it, so neither a core outage nor a restart loses it. One SQLite file per
 * account, `outbox.sqlite` next to `sync-token` on the persistent volume;
 * `claimStore` and the single replica make the account its only writer.
 *
 * The event is kept as `/sync` served it, still encrypted in an encrypted room,
 * so no plaintext is written at rest. It is decrypted on each try, which also
 * covers one still waiting for its room key.
 */

import { Database } from "bun:sqlite";
import type { RoomEvent } from "./matrix.ts";

/** Under core's 24 hour claim on an event id, so a retry that did land the first time is still dropped there. */
const TTL_MS = 12 * 60 * 60_000;
const MAX_ROWS = 5_000;
const MAX_BYTES = 50 * 1024 * 1024;

export interface OutboxEntry {
  attempts: number;
  eventId: string;
  firstSeenMs: number;
  roomId: string;
  /** Webhook URLs still owed the event. Null until its first try: every target. */
  targetsLeft: string[] | null;
}

/** A timeline event as `/sync` served it, and the room it came from. */
export interface OutboxEvent {
  event: RoomEvent;
  roomId: string;
}

interface OutboxRow {
  attempts: number;
  event_id: string;
  event_json: string;
  first_seen_ms: number;
  room_id: string;
  targets_left_json: string | null;
}

export class Outbox {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        first_seen_ms INTEGER NOT NULL,
        next_attempt_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        targets_left_json TEXT
      )`,
    );
  }

  /** One transaction per sync. An event already held keeps its place and its attempts. */
  add(events: readonly OutboxEvent[]): void {
    const insert = this.db.query<null, [string, string, string, number]>(
      `INSERT OR IGNORE INTO outbox
        (event_id, room_id, event_json, first_seen_ms, next_attempt_ms, attempts)
        VALUES (?1, ?2, ?3, ?4, 0, 0)`,
    );
    this.db.transaction((): void => {
      for (const { event, roomId } of events) {
        insert.run(event.event_id, roomId, JSON.stringify(event), Date.now());
      }
    })();
  }

  close(): void {
    this.db.close();
  }

  /** What is due now, oldest first. */
  due(): Array<OutboxEntry & { event: RoomEvent }> {
    return this.db
      .query<OutboxRow, [number]>(
        `SELECT event_id, room_id, event_json, first_seen_ms, attempts, targets_left_json
          FROM outbox WHERE next_attempt_ms <= ?1 ORDER BY rowid`,
      )
      .all(Date.now())
      .map((row): OutboxEntry & { event: RoomEvent } => {
        const event: RoomEvent = JSON.parse(row.event_json);

        return { ...entry(row), event: event };
      });
  }

  /** When the next held event is due, or null when there is none. */
  nextAttemptMs(): number | null {
    return (
      this.db
        .query<{ next: number | null }, []>(
          "SELECT MIN(next_attempt_ms) AS next FROM outbox",
        )
        .get()?.next ?? null
    );
  }

  /**
   * Deletes and returns what is past its TTL, then the oldest events beyond the
   * row or byte cap, so a target that never comes back cannot fill the volume.
   */
  prune(): Array<OutboxEntry & { expired: boolean }> {
    const expiredBeforeMs = Date.now() - TTL_MS;

    return this.db
      .query<Omit<OutboxRow, "event_json">, [number, number, number]>(
        `DELETE FROM outbox WHERE first_seen_ms <= ?1 OR rowid IN (
          SELECT rowid FROM (
            SELECT rowid,
              ROW_NUMBER() OVER newest AS position,
              SUM(LENGTH(CAST(event_json AS BLOB))) OVER newest AS bytes
            FROM outbox WINDOW newest AS (ORDER BY rowid DESC)
          ) WHERE position > ?2 OR bytes > ?3
        ) RETURNING event_id, room_id, first_seen_ms, attempts, targets_left_json`,
      )
      .all(expiredBeforeMs, MAX_ROWS, MAX_BYTES)
      .map((row): OutboxEntry & { expired: boolean } => ({
        ...entry(row),
        expired: row.first_seen_ms <= expiredBeforeMs,
      }));
  }

  /** Records a try that left targets owed, and when to try them again. */
  retry(
    eventId: string,
    attempts: number,
    nextAttemptMs: number,
    targetsLeft: readonly string[] | null,
  ): void {
    this.db
      .query<null, [number, number, string | null, string]>(
        `UPDATE outbox SET attempts = ?1, next_attempt_ms = ?2, targets_left_json = ?3
          WHERE event_id = ?4`,
      )
      .run(
        attempts,
        nextAttemptMs,
        targetsLeft === null ? null : JSON.stringify(targetsLeft),
        eventId,
      );
  }

  /** Every target took the event, or none wants it. */
  settle(eventId: string): void {
    this.db
      .query<null, [string]>("DELETE FROM outbox WHERE event_id = ?1")
      .run(eventId);
  }
}

function entry(row: Omit<OutboxRow, "event_json">): OutboxEntry {
  const targetsLeft: string[] | null =
    row.targets_left_json === null ? null : JSON.parse(row.targets_left_json);

  return {
    attempts: row.attempts,
    eventId: row.event_id,
    firstSeenMs: row.first_seen_ms,
    roomId: row.room_id,
    targetsLeft: targetsLeft,
  };
}
