"use client";

/**
 * Streams live logs or traces from the gateway observability WS, merging backfill
 * (spliced first) with live NATS entries (appended). The list is never cleared
 * into a spinner on reconnect. Protocol: ../observability-contracts.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ObservabilityLogEntry,
  ObservabilitySpanRow,
  ObservabilityClientMessage,
  ObservabilityServerMessage,
  LogLevel,
} from "../../../../packages/filthy-panty/src/observability-contracts";
import { resolveCoreEndpoint } from "@/app/lib/coreEndpoint";

// Re-export for consumers.
export type { ObservabilityLogEntry, ObservabilitySpanRow, LogLevel };

export type ObservabilityStreamStatus = "idle" | "connecting" | "live" | "error";

interface UseObservabilityStreamOptions {
  /** Which realtime stream to subscribe to. */
  stream: "logs" | "traces";
  /** Project slug, used in the WS path. Required to open the socket. */
  projectSlug: string | undefined;
  /** Environment slug, used in the WS path. Required to open the socket. */
  environmentSlug: string | undefined;
  /** Environment runtime API key (fp_…), passed as ?token=. Required to open the socket. */
  apiKey: string | undefined;
  /** Number of historic entries to request as backfill before live stream. 0 = live only. */
  backfill?: number;
  /** Minimum log level for live NATS relay (applies to "logs" stream only). Default: INFO. */
  minLevel?: LogLevel;
}

interface UseObservabilityStreamResult<T> {
  entries: T[];
  status: ObservabilityStreamStatus;
  error: string | null;
  refresh: () => void;
}

const RECONNECT_DELAY_MS = 3_000;
// Caps the accumulated list (keeping the most recent) so a long tail can't grow
// unbounded and the per-message dedup scan stays bounded.
const MAX_ENTRIES = 2_000;

export function useObservabilityStream(
  options: UseObservabilityStreamOptions & { stream: "logs" },
): UseObservabilityStreamResult<ObservabilityLogEntry>;
export function useObservabilityStream(
  options: UseObservabilityStreamOptions & { stream: "traces" },
): UseObservabilityStreamResult<ObservabilitySpanRow>;
export function useObservabilityStream(
  options: UseObservabilityStreamOptions,
): UseObservabilityStreamResult<ObservabilityLogEntry | ObservabilitySpanRow> {
  const { stream, projectSlug, environmentSlug, apiKey, backfill = 0, minLevel } = options;

  const [entries, setEntries] = useState<(ObservabilityLogEntry | ObservabilitySpanRow)[]>([]);
  const [status, setStatus] = useState<ObservabilityStreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset the list when the connection target changes (e.g. switching environment)
  // so one env's entries never bleed into the next — React's render-time
  // "adjust state when a prop changes" pattern, not an effect.
  const connKey = `${stream}|${projectSlug ?? ""}|${environmentSlug ?? ""}|${apiKey ?? ""}`;
  const [prevConnKey, setPrevConnKey] = useState(connKey);
  if (connKey !== prevConnKey) {
    setPrevConnKey(connKey);
    setEntries([]);
    setError(null);
  }

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
    if (s) {
      socketRef.current = null;
      if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
        s.close(1000, "cleanup");
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (destroyedRef.current) return;
    if (!coreEndpoint.ok) {
      setStatus("error");
      setError(coreEndpoint.message);
      return;
    }
    if (!projectSlug || !environmentSlug || !apiKey) {
      // Not enough info yet — stay idle; will reconnect when props settle.
      setStatus("idle");
      return;
    }

    closeSocket();
    clearReconnect();
    setStatus("connecting");
    setError(null);

    const wsUrl =
      `${coreEndpoint.websocketBaseUrl}/v1/${encodeURIComponent(projectSlug)}` +
      `/${encodeURIComponent(environmentSlug)}/observability/ws` +
      `?token=${encodeURIComponent(apiKey)}`;

    const socket = new WebSocket(wsUrl);
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
        setEntries((prev) => {
          const incoming = msg.entries as (ObservabilityLogEntry | ObservabilitySpanRow)[];
          const merged = new Map(prev.map((entry) => [entryKey(entry), entry]));
          for (const entry of incoming) merged.set(entryKey(entry), entry);
          const combined = [...merged.values()].sort((a, b) => entryTime(b) - entryTime(a));

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
          const existingIndex = prev.findIndex((candidate) => entryKey(candidate) === key);
          const next = existingIndex === -1
            ? [entry, ...prev]
            : prev.map((candidate, index) => index === existingIndex ? entry : candidate);
          next.sort((a, b) => entryTime(b) - entryTime(a));

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
      setError((current) => (current ?? event.reason) || `WebSocket closed (${event.code}).`);
      reconnectTimerRef.current = setTimeout(() => {
        if (!destroyedRef.current) connectRef.current();
      }, RECONNECT_DELAY_MS);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    coreEndpoint.ok,
    wsBaseUrl,
    coreErrorMessage,
    projectSlug,
    environmentSlug,
    apiKey,
    stream,
    backfill,
    minLevel,
    closeSocket,
    clearReconnect,
  ]);

  // Keep the reconnect timer pointed at the latest connect.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    destroyedRef.current = false;

    if (projectSlug && environmentSlug && apiKey) {
      // Connecting to the WebSocket on mount is the effect's purpose; the status
      // setState it performs is intentional external-system synchronization.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      connect();
    }

    return () => {
      destroyedRef.current = true;
      clearReconnect();
      closeSocket();
    };
  // Re-run when connection params change; connect is stable unless they change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, environmentSlug, apiKey, stream]);

  const refresh = useCallback(() => {
    if (projectSlug && environmentSlug && apiKey) connect();
  }, [projectSlug, environmentSlug, apiKey, connect]);

  return {
    entries: entries,
    status: status,
    error: error,
    refresh: refresh,
  };
}

// Dedup key: spans use the stable traceId+spanId; logs have no wire id, so fall
// back to ts + eventType + message.
function entryKey(entry: ObservabilityLogEntry | ObservabilitySpanRow): string {
  if ("spanId" in entry) {
    return `span:${entry.traceId}:${entry.spanId}`;
  }
  return `log:${entry.ts}:${entry.eventType}:${entry.message.slice(0, 80)}`;
}

function entryTime(entry: ObservabilityLogEntry | ObservabilitySpanRow): number {
  return "spanId" in entry ? entry.startTimeMs : entry.ts;
}
