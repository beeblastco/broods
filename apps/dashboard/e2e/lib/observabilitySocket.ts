import type { Page } from "@playwright/test";
import type {
  ObservabilityLogEntry,
  ObservabilityClientMessage,
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
      const message = JSON.parse(String(raw)) as ObservabilityClientMessage;
      if (message.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: message.stream,
          range: message.range,
          entries:
            (message.stream === "logs" ? streams.logs : streams.traces) ?? [],
        }),
      );
    });
  });
}
