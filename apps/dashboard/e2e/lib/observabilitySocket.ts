import type { Page } from "@playwright/test";
import type {
  ObservabilityLogEntry,
  ObservabilitySpanRow,
} from "../../../../packages/broods/src/observability-contracts";

export const NOW_MS = Date.parse("2026-09-15T10:00:00Z");

export async function answerObservabilitySocket(
  page: Page,
  streams: { logs?: ObservabilityLogEntry[]; traces?: ObservabilitySpanRow[] },
): Promise<void> {
  await page.clock.setFixedTime(NOW_MS);
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    socket.onMessage((raw) => {
      const message: { type: string; stream: string } = JSON.parse(String(raw));
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
