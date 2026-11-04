import { getConvexSize } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";

// Core trims a bigger Pi entry before saving; the save refuses one that still exceeds it.
export const MAX_HARNESS_SESSION_ENTRY_BYTES = 512 * 1_024;
// One entry batch per transaction leaves most of Convex's 16 MiB read and write budget free.
export const HARNESS_ENTRY_BATCH_BYTES = 4 * 1_024 * 1_024;
export const HARNESS_ENTRY_BATCH_ROWS = 100;

interface BatchLimits {
  bytes: number;
  rows: number;
}

const ENTRY_BATCH: BatchLimits = {
  bytes: HARNESS_ENTRY_BATCH_BYTES,
  rows: HARNESS_ENTRY_BATCH_ROWS,
};

// One entry of a session, by the id its harness gave it.
export async function findHarnessEntry(
  db: DatabaseReader,
  session: { conversationKey: string; sessionId: string },
  entryId: string,
): Promise<Doc<"runtimeHarnessSessionEntries"> | null> {
  return await db
    .query("runtimeHarnessSessionEntries")
    .withIndex("by_conversationKey_and_sessionId_and_entryId", (q) =>
      q
        .eq("conversationKey", session.conversationKey)
        .eq("sessionId", session.sessionId)
        .eq("entryId", entryId),
    )
    .first();
}

export function harnessEntryBytes(entry: string): number {
  return getConvexSize(entry);
}

// Splits one turn's entries into transactions; always returns at least one, maybe empty.
export function harnessEntryBatches<Entry extends { entry: string }>(
  entries: Entry[],
): Entry[][] {
  const batches: Entry[][] = [[]];
  let bytes = 0;
  for (const entry of entries) {
    const size = harnessEntryBytes(entry.entry);
    if (
      batches.at(-1)!.length >= ENTRY_BATCH.rows ||
      (bytes > 0 && bytes + size > ENTRY_BATCH.bytes)
    ) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1)!.push(entry);
    bytes += size;
  }

  return batches;
}

// Reads rows until a limit is reached, checked after each row so none is read twice.
export async function takeHarnessEntryBatch<Row extends { entry: string }>(
  rows: AsyncIterable<Row>,
  limits: BatchLimits = ENTRY_BATCH,
): Promise<{ batch: Row[]; full: boolean }> {
  const batch: Row[] = [];
  let bytes = 0;
  for await (const row of rows) {
    batch.push(row);
    bytes += harnessEntryBytes(row.entry);
    if (batch.length >= limits.rows || bytes >= limits.bytes) {
      return { batch: batch, full: true };
    }
  }

  return { batch: batch, full: false };
}
