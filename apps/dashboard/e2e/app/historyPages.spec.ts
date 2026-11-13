import { expect, test, type WebSocketRoute } from "@playwright/test";
import { hasProbe, MISSING_PROBE, readProjectId } from "../lib/session";
import type {
  ObservabilityClientMessage,
  ObservabilityLogEntry,
} from "../../../../packages/broods/src/observability-contracts";

test.skip(!hasProbe(), MISSING_PROBE);

test("history pages keep rows on failure and buffer live arrivals", async ({
  page,
}) => {
  const now = Date.now();
  const requests: ObservabilityClientMessage[] = [];
  let route: WebSocketRoute | undefined;
  let olderAttempts = 0;
  const row = (message: string, ts: number): ObservabilityLogEntry => ({
    ts: ts,
    message: message,
    level: "INFO",
    eventType: "",
  });
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    route = socket;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ObservabilityClientMessage;
      requests.push(message);
      if (message.type !== "subscribe") return;
      if (message.historyOnly) {
        olderAttempts += 1;
        socket.send(
          JSON.stringify({
            type: "backfill",
            stream: "logs",
            entries:
              olderAttempts === 1 ? [] : [row("older history", now - 2000)],
            ...(olderAttempts === 1
              ? { error: "History unavailable; retry" }
              : {}),
          }),
        );
      } else {
        socket.send(JSON.stringify({ type: "ready" }));
        socket.send(
          JSON.stringify({
            type: "log",
            entry: row("recent history", now - 1000),
          }),
        );
        socket.send(
          JSON.stringify({
            type: "backfill",
            stream: "logs",
            entries: [row("recent history", now - 1000)],
            nextTo: now - 1500,
          }),
        );
      }
    });
  });
  await page.goto(`/${readProjectId()}/dashboard?tab=monitoring`);
  await expect(
    page.getByRole("cell", { name: "recent history", exact: true }),
  ).toBeVisible();
  const initial = requests.find((message) => message.type === "subscribe");
  if (initial?.type !== "subscribe") throw new Error("missing subscribe");
  expect(initial.range!.to - initial.range!.from).toBe(3_600_000);
  await expect(
    page.getByRole("button", { name: /Show .* new logs/ }),
  ).toHaveCount(0);
  route!.send(
    JSON.stringify({ type: "log", entry: row("new live line", now) }),
  );
  await expect(
    page.getByRole("button", { name: "Show 1 new logs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "new live line", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Load older results" }).click();
  await expect(
    page.getByText("History unavailable; retry", { exact: true }),
  ).toContainText("History unavailable");
  await expect(
    page.getByRole("cell", { name: "recent history", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load older results" }).click();
  await expect(
    page.getByRole("cell", { name: "older history", exact: true }),
  ).toBeVisible();
  const pages = requests.filter(
    (message) => message.type === "subscribe" && message.historyOnly,
  );
  expect(pages).toHaveLength(2);
  expect(pages[0]).toEqual(pages[1]);
  expect(pages[0]).toMatchObject({
    range: { from: initial.range!.from, to: now - 1500 },
  });
  await page.getByRole("button", { name: "Show 1 new logs" }).click();
  await expect(
    page.getByRole("cell", { name: "new live line", exact: true }),
  ).toBeVisible();
});
