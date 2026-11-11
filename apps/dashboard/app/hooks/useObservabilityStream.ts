"use client";

import { useParams } from "next/navigation";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";
import { STREAM_COMMIT_MS } from "@/app/lib/perfReport";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  TaskWaitingOn,
} from "../../../../packages/broods/src/observability-contracts";

export { isRootSpanKind, isTraceId };
export type {
  LogLevel,
  ObservabilityLogEntry,
  ObservabilitySpanRow,
  TaskWaitingOn,
};

export type ObservabilityStreamStatus =
  | "idle"
  | "connecting"
  | "live"
  | "error";

export type ObservabilityHistoryStatus =
  | "none"
  | "loading"
  | "loaded"
  | "failed";

interface UseObservabilityStreamOptions {
  stream: "logs" | "traces";
  projectSlug: string | undefined;
  stageSlug: string | undefined;
  apiKey: string | undefined;
  backfill?: number;
  minLevel?: LogLevel;
  sandboxId?: string;
}

interface UseObservabilityStreamResult<T> {
  entries: T[];
  status: ObservabilityStreamStatus;
  history: ObservabilityHistoryStatus;
  error: string | null;
  refresh: () => void;
  /** False when the socket is not live, so the caller records no request that never went out. */
  fetchTrace: (traceId: string) => boolean;
}

// Tempo's `tempo.retention` in the infra repo's tempo chart; older traces cannot be fetched.
export const TRACE_RETENTION_DAYS = 30;
const RECONNECT_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
// The gateway revoked the stage session: redialling with it only counts auth failures.
const REVOKED_CLOSE_CODE = 4401;
const MAX_ENTRIES = 2_000;
// The gateway's own replay window: a cursor older than this may have aged out of the stream.
const RESUME_WINDOW_MS = 30 * 60 * 1000;

export interface ResumeCursor {
  key: string;
  seq: number;
  at: number;
  historyLoaded: boolean;
}

const STREAM_CACHE = new Map<
  string,
  (ObservabilityLogEntry | ObservabilitySpanRow)[]
>();
const STREAM_CACHE_MAX_KEYS = 8;

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

  // The project id, not its slug (unique per org), and no credential: a renewed ticket
  // reconnects the same stream and keeps its entries.
  const { projectId } = useParams<{ projectId: string }>();
  const connKey = `${stream}|${projectId}|${stageSlug ?? ""}|${sandboxId ?? ""}|${minLevel ?? ""}`;

  const [entries, setEntries] = useState<
    (ObservabilityLogEntry | ObservabilitySpanRow)[]
  >(() => STREAM_CACHE.get(connKey) ?? []);
  const [status, setStatus] = useState<ObservabilityStreamStatus>("idle");
  const [history, setHistory] = useState<ObservabilityHistoryStatus>("none");
  const [error, setError] = useState<string | null>(null);

  const [prevConnKey, setPrevConnKey] = useState(connKey);
  if (connKey !== prevConnKey) {
    setPrevConnKey(connKey);
    setEntries(STREAM_CACHE.get(connKey) ?? []);
    setError(null);
  }

  const liveRef = useRef<(ObservabilityLogEntry | ObservabilitySpanRow)[]>([]);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeRef = useRef(connKey);
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- commit timer, cut before paint
  useLayoutEffect(() => {
    scopeRef.current = connKey;

    return () => {
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      liveRef.current = [];
    };
  }, [connKey]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- module-level STREAM_CACHE
  useEffect(() => {
    cacheEntries(connKey, entries);
  }, [connKey, entries]);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const destroyedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  const cursorRef = useRef<ResumeCursor | null>(null);
  // A trace lookup answers with a backfill frame too; it says nothing about the list.
  const traceFetchRef = useRef(false);

  const coreEndpoint = resolveCoreEndpoint();
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
      // Closing mid-handshake logs a browser error and counts as a failed connection.
      s.onopen = () => s.close(1000, "superseded");
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
    }
  }, []);

  const flushLive = useCallback(() => {
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    const batch = liveRef.current;
    if (batch.length === 0) return;
    liveRef.current = [];
    setEntries((prev) => mergeLive(prev, batch));
  }, []);

  const connect = useCallback(() => {
    if (destroyedRef.current) return;
    if (coreErrorMessage) {
      setStatus("error");
      setError(coreErrorMessage);

      return;
    }
    if (!projectSlug || !stageSlug || !apiKey) return;

    closeSocket();
    clearReconnect();
    setStatus("connecting");
    const resumeSeq = resumeSeqFor(
      cursorRef.current,
      connKey,
      minLevel,
      Date.now(),
    );
    if (resumeSeq === undefined) setHistory(backfill > 0 ? "loading" : "none");
    setError(null);

    const wsUrl =
      `${wsBaseUrl}/v1/projects/${encodeURIComponent(projectSlug)}` +
      `/stages/${encodeURIComponent(stageSlug)}/observability/ws`;

    // Credential in the subprotocol list, never the URL (see useAgentChat).
    const socket = new WebSocket(wsUrl, [
      "broods.v1",
      `broods.token.${apiKey}`,
    ]);
    socketRef.current = socket;
    traceFetchRef.current = false;

    socket.onopen = () => {
      if (destroyedRef.current || socketRef.current !== socket) {
        socket.close(1000, "superseded");

        return;
      }

      const subscribeMsg: ObservabilityClientMessage = {
        type: "subscribe",
        stream: stream,
        ...(resumeSeq !== undefined
          ? { afterSeq: resumeSeq }
          : backfill > 0
            ? { backfill: backfill }
            : {}),
        ...(minLevel ? { minLevel: minLevel } : {}),
        ...(sandboxId ? { sandboxId: sandboxId } : {}),
      };
      socket.send(JSON.stringify(subscribeMsg));
    };

    socket.onmessage = (event) => {
      if (
        destroyedRef.current ||
        socketRef.current !== socket ||
        scopeRef.current !== connKey
      ) {
        return;
      }
      if (typeof event.data !== "string") return;

      let msg: ObservabilityServerMessage;
      try {
        msg = JSON.parse(event.data) as ObservabilityServerMessage;
      } catch {
        return;
      }

      if (msg.type === "ready") {
        attemptRef.current = 0;
        setStatus("live");
        cursorRef.current =
          msg.seq === undefined
            ? null
            : {
                key: connKey,
                seq: msg.seq,
                at: Date.now(),
                historyLoaded: resumeSeq !== undefined,
              };

        return;
      }

      if (msg.type === "backfill") {
        if (!msg.more) {
          setHistory(msg.error ? "failed" : "loaded");
          if (traceFetchRef.current) traceFetchRef.current = false;
          else if (cursorRef.current)
            cursorRef.current.historyLoaded = !msg.error;
        }
        if (msg.error) setError(msg.error);
        flushLive();
        setEntries((prev) => mergeBackfill(prev, msg.entries));

        return;
      }

      if (msg.type === "log" || msg.type === "span") {
        // A hidden tab throttles timers, so a full queue folds now instead of growing.
        liveRef.current.push(msg.entry);
        if (msg.seq !== undefined && cursorRef.current) {
          cursorRef.current.seq = msg.seq;
          cursorRef.current.at = Date.now();
        }
        if (liveRef.current.length >= MAX_ENTRIES) flushLive();
        else commitTimerRef.current ??= setTimeout(flushLive, STREAM_COMMIT_MS);

        return;
      }

      if (msg.type === "error") {
        setStatus("error");
        setError(msg.error);
        setHistory((current) => (current === "loading" ? "failed" : current));
      }
    };

    socket.onerror = () => {
      if (destroyedRef.current || socketRef.current !== socket) return;
      setStatus("error");
      setError("WebSocket transport error.");
      setHistory((current) => (current === "loading" ? "failed" : current));
    };

    socket.onclose = (event) => {
      if (destroyedRef.current || socketRef.current !== socket) return;
      socketRef.current = null;

      if (event.code === 1000) {
        setStatus("idle");

        return;
      }

      setStatus("error");
      setError(
        (current) =>
          (current ?? event.reason) || `WebSocket closed (${event.code}).`,
      );
      setHistory((current) => (current === "loading" ? "failed" : current));
      const delay = reconnectDelay(event.code, attemptRef.current);
      if (delay === null) return;
      attemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (!destroyedRef.current) connectRef.current();
      }, delay);
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
    connKey,
    closeSocket,
    clearReconnect,
    flushLive,
  ]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- the observability WebSocket
  useEffect(() => {
    connectRef.current = connect;
    destroyedRef.current = false;
    attemptRef.current = 0;
    // oxlint-disable-next-line react/set-state-in-effect -- connect marks the socket connecting
    if (projectSlug && stageSlug && apiKey) connect();

    return () => {
      destroyedRef.current = true;
      clearReconnect();
      closeSocket();
    };
  }, [projectSlug, stageSlug, apiKey, connect, clearReconnect, closeSocket]);

  const refresh = useCallback(() => {
    cursorRef.current = null;
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
    traceFetchRef.current = true;
    setError(null);
    socket.send(JSON.stringify(message));

    return true;
  }, []);

  return {
    entries: entries,
    status: projectSlug && stageSlug && apiKey ? status : "idle",
    history: history,
    error: error,
    refresh: refresh,
    fetchTrace: fetchTrace,
  };
}

export function entryKey(
  entry: ObservabilityLogEntry | ObservabilitySpanRow,
): string {
  if ("spanId" in entry) {
    return `span:${entry.traceId}:${entry.spanId}`;
  }

  return entry.logId
    ? `log:${entry.logId}`
    : `log:${entry.ts}:${entry.eventType}:${entry.message}`;
}

export function mergeBackfill<
  T extends ObservabilityLogEntry | ObservabilitySpanRow,
>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev;
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
}

// Same list as applying the batch one entry at a time in arrival order, capped once at the end.
export function mergeLive<
  T extends ObservabilityLogEntry | ObservabilitySpanRow,
>(prev: T[], batch: T[]): T[] {
  const listed = [...prev];
  const slots = new Map(prev.map((entry, index) => [entryKey(entry), index]));
  const fresh = new Map<string, T>();
  for (const entry of batch) {
    const key = entryKey(entry);
    const slot = slots.get(key);
    if (slot !== undefined) {
      listed[slot] = preferEntry(listed[slot], entry);
      continue;
    }
    const queued = fresh.get(key);
    fresh.set(key, queued ? preferEntry(queued, entry) : entry);
  }
  const next = [...fresh.values()]
    .reverse()
    .concat(listed)
    .sort((a, b) => entryTime(b) - entryTime(a));

  return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
}

/** Doubles from 3 s to a minute; null when the close means a new credential is needed. */
export function reconnectDelay(code: number, attempt: number): number | null {
  if (code === REVOKED_CLOSE_CODE) return null;

  return Math.min(RECONNECT_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

/** The cursor a reconnect resumes after, or undefined when it must load history again. */
export function resumeSeqFor(
  cursor: ResumeCursor | null,
  key: string,
  minLevel: LogLevel | undefined,
  now: number,
): number | undefined {
  // DEBUG lines never ride the live relay, so only a backfill brings the new ones.
  return cursor?.key === key &&
    cursor.historyLoaded &&
    minLevel !== "DEBUG" &&
    now - cursor.at < RESUME_WINDOW_MS
    ? cursor.seq
    : undefined;
}

function cacheEntries(
  key: string,
  entries: (ObservabilityLogEntry | ObservabilitySpanRow)[],
): void {
  STREAM_CACHE.delete(key);
  STREAM_CACHE.set(key, entries);
  while (STREAM_CACHE.size > STREAM_CACHE_MAX_KEYS) {
    const oldest = STREAM_CACHE.keys().next().value;
    if (oldest === undefined) break;
    STREAM_CACHE.delete(oldest);
  }
}

function entryTime(
  entry: ObservabilityLogEntry | ObservabilitySpanRow,
): number {
  return "spanId" in entry ? entry.startTimeMs : entry.ts;
}

// A span re-arrives as it ends and from Tempo, which truncates attributes: keep the better copy.
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
    Object.values(span.attributes ?? {}).reduce<number>(
      (total, value) => total + (typeof value === "string" ? value.length : 1),
      0,
    );

  return size(b) >= size(a) ? incoming : existing;
}
