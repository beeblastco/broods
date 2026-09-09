"use client";

/**
 * Streams live logs or traces from the gateway observability WS, merging backfill
 * (spliced first) with live entries (appended): the NATS relay, or the gateway's
 * Loki poll when tailing one sandbox. The list is never cleared into a spinner
 * on reconnect. Protocol: ../observability-contracts.ts.
 */

import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isRootSpanKind,
  isTraceId,
} from "../../../../packages/broods/src/observability-contracts";
import type {
  LogLevel,
  ObservabilityClientMessage,
  ObservabilityLogEntry,
  ObservabilityServerMessage,
  ObservabilitySpanRow,
} from "../../../../packages/broods/src/observability-contracts";

// Re-export for consumers.
export { isRootSpanKind, isTraceId };
export type { LogLevel, ObservabilityLogEntry, ObservabilitySpanRow };

export type ObservabilityStreamStatus =
  | "idle"
  | "connecting"
  | "live"
  | "error";

/**
 * Where the durable backfill (Loki or Tempo) stands for this connection. The
 * live relay keeps flowing whatever this says; it decides only what an empty
 * list means. "none" = no backfill was asked for.
 */
export type ObservabilityHistoryStatus =
  | "none"
  | "loading"
  | "loaded"
  | "failed";

interface UseObservabilityStreamOptions {
  /** Which realtime stream to subscribe to. */
  stream: "logs" | "traces";
  /** Project slug, used in the WS path. Required to open the socket. */
  projectSlug: string | undefined;
  /** Stage slug, used in the WS path. Required to open the socket. */
  stageSlug: string | undefined;
  /** Stage runtime API key (fp_…), passed as ?token=. Required to open the socket. */
  apiKey: string | undefined;
  /** Number of historic entries to request as backfill before live stream. 0 = live only. */
  backfill?: number;
  /** Minimum log level for live NATS relay (applies to "logs" stream only). Default: INFO. */
  minLevel?: LogLevel;
  /**
   * Tail one sandbox instance's guest output instead of the deployment's logs
   * ("logs" stream only). The last segment of the instance's `logStream`.
   */
  sandboxId?: string;
}

interface UseObservabilityStreamResult<T> {
  entries: T[];
  status: ObservabilityStreamStatus;
  history: ObservabilityHistoryStatus;
  error: string | null;
  refresh: () => void;
  /**
   * Pull one trace by id from Tempo, for a trace older than the backfill
   * window ("traces" stream only). Its spans merge into `entries`; a miss
   * lands in `error`. Returns whether the request was actually sent — false
   * when the socket is not live, so the caller does not record a request that
   * never went out.
   */
  fetchTrace: (traceId: string) => boolean;
}

const RECONNECT_DELAY_MS = 3_000;
// Caps the accumulated list (keeping the most recent) so a long tail can't grow
// unbounded and the per-message dedup scan stays bounded.
const MAX_ENTRIES = 2_000;

// Module-level cache keyed by the connection key (stream + scope). Switching
// dashboard tabs unmounts the panel; on remount we seed from this cache so the
// last entries paint instantly while the socket reconnects and refreshes in the
// background — no re-spinner and no waiting on the slow durable backfill.
const STREAM_CACHE = new Map<
  string,
  (ObservabilityLogEntry | ObservabilitySpanRow)[]
>();
// Bounds the cache across scopes — without it every stream/stage/key combo
// visited in a session pins up to MAX_ENTRIES rows for the page's lifetime.
const STREAM_CACHE_MAX_KEYS = 8;

function cacheEntries(
  key: string,
  entries: (ObservabilityLogEntry | ObservabilitySpanRow)[],
): void {
  // Re-insert so iteration order doubles as LRU order.
  STREAM_CACHE.delete(key);
  STREAM_CACHE.set(key, entries);
  while (STREAM_CACHE.size > STREAM_CACHE_MAX_KEYS) {
    const oldest = STREAM_CACHE.keys().next().value;
    if (oldest === undefined) break;
    STREAM_CACHE.delete(oldest);
  }
}

export function useObservabilityStream(
  options: UseObservabilityStreamOptions & { stream: "logs" },
): UseObservabilityStreamResult<ObservabilityLogEntry>;
export function useObservabilityStream(
  options: UseObservabilityStreamOptions & { stream: "traces" },
): UseObservabilityStreamResult<ObservabilitySpanRow>;
export function useObservabilityStream(
  options: UseObservabilityStreamOptions,
): UseObservabilityStreamResult<ObservabilityLogEntry | ObservabilitySpanRow> {
  const {
    stream,
    projectSlug,
    stageSlug,
    apiKey,
    backfill = 0,
    minLevel,
    sandboxId,
  } = options;

  // Cache key for this stream + scope; entries are seeded from / written back to
  // STREAM_CACHE so remounts (tab switches) are instant.
  const connKey = `${stream}|${projectSlug ?? ""}|${stageSlug ?? ""}|${apiKey ?? ""}|${sandboxId ?? ""}`;

  const [entries, setEntries] = useState<
    (ObservabilityLogEntry | ObservabilitySpanRow)[]
  >(() => STREAM_CACHE.get(connKey) ?? []);
  const [status, setStatus] = useState<ObservabilityStreamStatus>("idle");
  const [history, setHistory] = useState<ObservabilityHistoryStatus>("none");
  const [error, setError] = useState<string | null>(null);

  // Seed from cache when the connection target changes (e.g. switching
  // stage) so one stage's entries never bleed into the next while still
  // painting instantly if we've seen this scope before — React's render-time
  // "adjust state when a prop changes" pattern, not an effect.
  const [prevConnKey, setPrevConnKey] = useState(connKey);
  if (connKey !== prevConnKey) {
    setPrevConnKey(connKey);
    setEntries(STREAM_CACHE.get(connKey) ?? []);
    setError(null);
  }

  // Persist the latest list so the next mount with the same scope can seed from it.
  useEffect(() => {
    cacheEntries(connKey, entries);
  }, [connKey, entries]);

  // Refs so the effect closure captures stable references.
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyedRef = useRef(false);
  // Holds the latest `connect` so the reconnect timer can call it without
  // `connect` referencing itself (which would capture a stale closure / trip the
  // "used before declared" lint).
  const connectRef = useRef<() => void>(() => {});

  const coreEndpoint = resolveCoreEndpoint();
  // Extract the ok-guarded fields so the connect deps below stay stable primitives
  // (and statically checkable by the hooks lint).
  const wsBaseUrl = coreEndpoint.ok ? coreEndpoint.websocketBaseUrl : "";
  const coreErrorMessage = coreEndpoint.ok ? "" : coreEndpoint.message;

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    const s = socketRef.current;
    if (!s) return;
    socketRef.current = null;
    if (s.readyState === WebSocket.OPEN) {
      s.close(1000, "cleanup");
    } else if (s.readyState === WebSocket.CONNECTING) {
      // Closing mid-handshake makes the browser log "WebSocket is closed
      // before the connection is established" and counts as a failed
      // connection; let the handshake finish, then hang up cleanly.
      s.onopen = () => s.close(1000, "superseded");
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (destroyedRef.current) return;
    if (coreErrorMessage) {
      setStatus("error");
      setError(coreErrorMessage);

      return;
    }
    if (!projectSlug || !stageSlug || !apiKey) {
      // Not enough info yet — stay idle; will reconnect when props settle.
      setStatus("idle");

      return;
    }

    closeSocket();
    clearReconnect();
    setStatus("connecting");
    setHistory(backfill > 0 ? "loading" : "none");
    setError(null);

    const wsUrl =
      `${wsBaseUrl}/v1/${encodeURIComponent(projectSlug)}` +
      `/${encodeURIComponent(stageSlug)}/observability/ws`;

    // Credential in the subprotocol list, never the URL (see useAgentChat).
    const socket = new WebSocket(wsUrl, [
      "broods.v1",
      `broods.token.${apiKey}`,
    ]);
    socketRef.current = socket;

    socket.onopen = () => {
      if (destroyedRef.current || socketRef.current !== socket) {
        socket.close(1000, "superseded");

        return;
      }

      const subscribeMsg: ObservabilityClientMessage = {
        type: "subscribe",
        stream: stream,
        ...(backfill > 0 ? { backfill: backfill } : {}),
        ...(minLevel ? { minLevel: minLevel } : {}),
        ...(sandboxId ? { sandboxId: sandboxId } : {}),
      };
      socket.send(JSON.stringify(subscribeMsg));
    };

    socket.onmessage = (event) => {
      if (destroyedRef.current || socketRef.current !== socket) return;
      if (typeof event.data !== "string") return;

      let msg: ObservabilityServerMessage;
      try {
        msg = JSON.parse(event.data) as ObservabilityServerMessage;
      } catch {
        return;
      }

      if (msg.type === "ready") {
        setStatus("live");

        return;
      }

      if (msg.type === "backfill") {
        // A traces backfill arrives newest-first in pieces flagged `more`;
        // the closing piece (no flag) settles history and names a failure
        // instead of looking empty. Logs and fetchTrace answer in one piece.
        if (!msg.more) setHistory(msg.error ? "failed" : "loaded");
        if (msg.error) setError(msg.error);
        setEntries((prev) => {
          const incoming = msg.entries as (
            | ObservabilityLogEntry
            | ObservabilitySpanRow
          )[];
          const merged = new Map(prev.map((entry) => [entryKey(entry), entry]));
          for (const entry of incoming) {
            const key = entryKey(entry);
            const existing = merged.get(key);
            merged.set(key, existing ? preferEntry(existing, entry) : entry);
          }
          const combined = [...merged.values()].sort(
            (a, b) => entryTime(b) - entryTime(a),
          );

          return combined.length > MAX_ENTRIES
            ? combined.slice(0, MAX_ENTRIES)
            : combined;
        });

        return;
      }

      if (msg.type === "log" || msg.type === "span") {
        const entry = msg.entry;
        setEntries((prev) => {
          const key = entryKey(entry);
          const existingIndex = prev.findIndex(
            (candidate) => entryKey(candidate) === key,
          );
          // A replacement keeps its slot (the dedup key pins the timestamp),
          // and live entries almost always arrive in order — so the full
          // re-sort runs only for a genuinely out-of-order arrival instead of
          // on every message.
          if (existingIndex !== -1) {
            return prev.map((candidate, index) =>
              index === existingIndex
                ? preferEntry(candidate, entry)
                : candidate,
            );
          }
          const next = [entry, ...prev];
          if (prev.length > 0 && entryTime(entry) < entryTime(prev[0])) {
            next.sort((a, b) => entryTime(b) - entryTime(a));
          }

          return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
        });

        return;
      }

      if (msg.type === "error") {
        setStatus("error");
        setError(msg.error);
      }
    };

    socket.onerror = () => {
      if (destroyedRef.current || socketRef.current !== socket) return;
      setStatus("error");
      setError("WebSocket transport error.");
    };

    socket.onclose = (event) => {
      if (destroyedRef.current || socketRef.current !== socket) return;
      socketRef.current = null;

      if (event.code === 1000) {
        // Normal close — do not reconnect.
        setStatus("idle");

        return;
      }

      // Unexpected close — show the failure while waiting, then reconnect after
      // a delay without clearing existing entries.
      setStatus("error");
      setError(
        (current) =>
          (current ?? event.reason) || `WebSocket closed (${event.code}).`,
      );
      reconnectTimerRef.current = setTimeout(() => {
        if (!destroyedRef.current) connectRef.current();
      }, RECONNECT_DELAY_MS);
    };
  }, [
    wsBaseUrl,
    coreErrorMessage,
    projectSlug,
    stageSlug,
    apiKey,
    stream,
    backfill,
    minLevel,
    sandboxId,
    closeSocket,
    clearReconnect,
  ]);

  // Keep the reconnect timer pointed at the latest connect.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // `connect` already changes whenever a connection parameter does; the other
  // deps only satisfy the hooks lint. Connecting is the effect's purpose; the
  // status setState it performs is external-system synchronization.
  useEffect(() => {
    destroyedRef.current = false;
    if (projectSlug && stageSlug && apiKey) connect();

    return () => {
      destroyedRef.current = true;
      clearReconnect();
      closeSocket();
    };
  }, [projectSlug, stageSlug, apiKey, connect, clearReconnect, closeSocket]);

  const refresh = useCallback(() => {
    if (projectSlug && stageSlug && apiKey) connect();
  }, [projectSlug, stageSlug, apiKey, connect]);

  const fetchTrace = useCallback((traceId: string): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const message: ObservabilityClientMessage = {
      type: "fetchTrace",
      traceId: traceId,
    };
    setHistory("loading");
    setError(null);
    socket.send(JSON.stringify(message));

    return true;
  }, []);

  return {
    entries: entries,
    status: status,
    history: history,
    error: error,
    refresh: refresh,
    fetchTrace: fetchTrace,
  };
}

// Dedup key: spans use the stable traceId+spanId; logs have no wire id, so fall
// back to ts + eventType + message. Also the React key for a row: an index key
// remounts every row when a live entry is prepended.
export function entryKey(
  entry: ObservabilityLogEntry | ObservabilitySpanRow,
): string {
  if ("spanId" in entry) {
    return `span:${entry.traceId}:${entry.spanId}`;
  }

  return `log:${entry.ts}:${entry.eventType}:${entry.message.slice(0, 80)}`;
}

function entryTime(
  entry: ObservabilityLogEntry | ObservabilitySpanRow,
): number {
  return "spanId" in entry ? entry.startTimeMs : entry.ts;
}

// The same span arrives more than once: as it progresses (running -> ok/error) and
// from two sources (full-fidelity JetStream replay vs a Tempo backfill that
// truncates large attributes). Keep the better copy so a reload never downgrades a
// span: a terminal status beats "running", and among equals the richer payload
// wins. Logs have no such progression — the incoming copy wins.
function preferEntry<T extends ObservabilityLogEntry | ObservabilitySpanRow>(
  existing: T,
  incoming: T,
): T {
  if (!("spanId" in existing) || !("spanId" in incoming)) return incoming;
  const a = existing as ObservabilitySpanRow;
  const b = incoming as ObservabilitySpanRow;
  const rank = (status: ObservabilitySpanRow["status"]): number =>
    status === "running" ? 0 : 1;
  if (rank(b.status) !== rank(a.status)) {
    return rank(b.status) > rank(a.status) ? incoming : existing;
  }
  const size = (span: ObservabilitySpanRow): number =>
    JSON.stringify(span.attributes ?? {}).length;

  return size(b) >= size(a) ? incoming : existing;
}
