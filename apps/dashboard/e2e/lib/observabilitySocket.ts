import type { Page } from "@playwright/test";
import type {
  ObservabilityLogEntry,
  ObservabilitySpanRow,
} from "../../../../packages/broods/src/observability-contracts";

/** The page's frozen clock; fixtures date their entries against it. */
export const NOW_MS = Date.parse("2026-09-15T10:00:00Z");

/**
 * Freeze the page clock at `NOW_MS` and answer each observability
 * subscription with one backfill: `logs` for the log stream, `traces` for
 * the trace stream.
 */
export async function answerObservabilitySocket(
  page: Page,
  streams: { logs?: ObservabilityLogEntry[]; traces?: ObservabilitySpanRow[] },
): Promise<void> {
  await page.clock.setFixedTime(NOW_MS);
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        stream: string;
      };
      if (message.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: message.stream,
          entries:
            (message.stream === "logs" ? streams.logs : streams.traces) ?? [],
        }),
      );
    });
  });
}
