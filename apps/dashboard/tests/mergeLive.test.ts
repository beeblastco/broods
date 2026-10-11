import { expect, test } from "bun:test";
import {
  entryKey,
  mergeLive,
  type ObservabilityLogEntry,
  type ObservabilitySpanRow,
} from "../app/hooks/useObservabilityStream";

type Entry = ObservabilityLogEntry | ObservabilitySpanRow;

function span(
  spanId: string,
  startTimeMs: number,
  status: ObservabilitySpanRow["status"] = "ok",
): ObservabilitySpanRow {
  return {
    traceId: "trace-1",
    spanId: spanId,
    name: "agent.task",
    kind: "task",
    startTimeMs: startTimeMs,
    endTimeMs: startTimeMs + 1_000,
    durationMs: 1_000,
    status: status,
    attributes: {},
  };
}

function log(message: string, ts: number): ObservabilityLogEntry {
  return { ts: ts, level: "INFO", eventType: "", message: message };
}

const time = (entry: Entry): number =>
  "spanId" in entry ? entry.startTimeMs : entry.ts;

// The per-message fold the hook ran before live entries were batched, kept
// verbatim as the reference a batch must reproduce.
function applyOne<T extends Entry>(prev: T[], entry: T): T[] {
  const key = entryKey(entry);
  const existingIndex = prev.findIndex(
    (candidate) => entryKey(candidate) === key,
  );
  if (existingIndex !== -1) {
    return prev.map((candidate, index) =>
      index === existingIndex ? preferReference(candidate, entry) : candidate,
    );
  }
  const next = [entry, ...prev];
  if (prev.length > 0 && time(entry) < time(prev[0])) {
    next.sort((a, b) => time(b) - time(a));
  }

  return next.length > 2_000 ? next.slice(0, 2_000) : next;
}

// The hook's span preference: a finished copy beats a running one.
function preferReference<T extends Entry>(existing: T, incoming: T): T {
  if (!("spanId" in existing) || !("spanId" in incoming)) return incoming;
  const rank = (entry: Entry): number =>
    "spanId" in entry && entry.status === "running" ? 0 : 1;

  return rank(incoming) >= rank(existing) ? incoming : existing;
}

// Deterministic, so a failure replays.
function random(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;

    return state / 2 ** 31;
  };
}

test("a frame of live entries lands exactly as one entry at a time did", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const pick = (): Entry => {
      // Few distinct times and keys, so ties, repeats and stragglers abound.
      const at = Math.floor(next() * 40);
      const id = String(Math.floor(next() * 60));
      if (next() < 0.5) return log(`line ${id}`, at);
      const status = next() < 0.4 ? "running" : "ok";

      return span(id, Number(id) % 40, status);
    };
    const prev = Array.from({ length: Math.floor(next() * 30) }, pick).reduce(
      applyOne,
      [] as Entry[],
    );
    const batch = Array.from({ length: Math.floor(next() * 80) }, pick);

    expect(mergeLive(prev, batch)).toEqual(batch.reduce(applyOne, prev));
  }
});

test("a straggler older than the newest row sorts into place", () => {
  const merged = mergeLive(
    [log("c", 30), log("a", 10)],
    [log("d", 40), log("b", 20)],
  );

  expect(merged.map((entry) => entry.message)).toEqual(["d", "c", "b", "a"]);
});

test("a running span arriving after its finished copy does not downgrade it", () => {
  const merged = mergeLive(
    [span("a", 1_000, "ok")],
    [span("a", 1_000, "running")],
  );

  expect(merged.map((row) => row.status)).toEqual(["ok"]);
});

test("a burst keeps the newest 2,000 rows", () => {
  const burst = Array.from({ length: 2_500 }, (_, index) =>
    log(`line ${index}`, index),
  );
  const merged = mergeLive([log("old", -1)], burst);

  expect(merged).toHaveLength(2_000);
  expect(merged[0].message).toBe("line 2499");
  expect(merged.at(-1)?.message).toBe("line 500");
});
