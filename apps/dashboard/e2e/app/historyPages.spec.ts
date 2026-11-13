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
            range: message.range,
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
            range: message.range,
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

test("an open-ended history window sends finite protocol bounds", async ({
  page,
}) => {
  const requests: ObservabilityClientMessage[] = [];
  let route: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    route = socket;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ObservabilityClientMessage;
      requests.push(message);
      if (message.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: "traces",
          range: message.range,
          entries: [],
        }),
      );
    });
  });
  await page.goto(
    `/${readProjectId()}/dashboard?tab=tracing&from=${Date.now() - 35 * 86_400_000}`,
  );
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  const request = requests[0];
  if (request?.type !== "subscribe") throw new Error("missing subscribe");
  expect(Number.isSafeInteger(request.range?.to)).toBe(true);
  expect(Number.isSafeInteger(request.range?.from)).toBe(true);
  expect(request.range!.to - request.range!.from).toBeLessThanOrEqual(
    30 * 86_400_000,
  );
  route!.send(
    JSON.stringify({
      type: "span",
      entry: {
        traceId: "e".repeat(32),
        spanId: "live-root",
        name: "agent.task",
        kind: "task",
        status: "running",
        startTimeMs: request.range!.to + 1,
      },
    }),
  );
  await expect(
    page.getByRole("button", { name: "Show 1 new runs" }),
  ).toBeVisible();
});

test("a history response without a matching range is not accepted as a page", async ({
  page,
}) => {
  let attempt = 0;
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ObservabilityClientMessage;
      if (message.type !== "subscribe") return;
      attempt += 1;
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: "logs",
          ...(attempt > 1
            ? {
                range: {
                  from: message.range!.from + (attempt === 2 ? 1 : 0),
                  to: message.range!.to,
                },
              }
            : {}),
          entries: [
            {
              ts: Date.now() - 1000,
              message: "unbounded result",
              level: "INFO",
              eventType: "",
            },
          ],
          nextTo: Date.now() - 2000,
        }),
      );
    });
  });
  await page.goto(`/${readProjectId()}/dashboard?tab=monitoring`);
  await expect(page.locator('[data-history-state="failed"]')).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "unbounded result", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load older results" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => attempt).toBe(2);
  await expect(page.locator('[data-history-state="failed"]')).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "unbounded result", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('[data-history-state="loaded"]')).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "unbounded result", exact: true }),
  ).toBeVisible();
});

test("a fetched trace survives widening its selected range", async ({
  page,
}) => {
  const traceId = "c".repeat(32);
  const now = Date.now();
  let fetches = 0;
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as ObservabilityClientMessage;
      if (request.type === "subscribe") {
        socket.send(JSON.stringify({ type: "ready" }));
        socket.send(
          JSON.stringify({
            type: "backfill",
            stream: "traces",
            range: request.range,
            entries: [],
          }),
        );
      } else if (request.type === "fetchTrace") {
        fetches += 1;
        socket.send(
          JSON.stringify({
            type: "backfill",
            stream: "traces",
            entries: [
              {
                traceId: traceId,
                spanId: "old-root",
                name: "agent.task",
                kind: "task",
                status: "ok",
                startTimeMs: now - 7_200_000,
                endTimeMs: now - 7_199_000,
                durationMs: 1000,
                attributes: { "task.input": "linked older run" },
              },
            ],
          }),
        );
      }
    });
  });
  await page.goto(`/${readProjectId()}/dashboard?tab=tracing&trace=${traceId}`);
  await expect(page.locator(`#task-${traceId}`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(fetches).toBe(1);
});

test("a new span in a loaded trace does not evict its root", async ({
  page,
}) => {
  const traceId = "d".repeat(32);
  const now = Date.now();
  let route: WebSocketRoute | undefined;
  const root = {
    traceId: traceId,
    spanId: "loaded-root",
    name: "agent.task",
    kind: "task",
    status: "ok",
    startTimeMs: now - 100_000,
    endTimeMs: now - 99_000,
    durationMs: 1000,
    attributes: { "task.input": "loaded root" },
  };
  const child = {
    ...root,
    spanId: "child-new",
    kind: "step",
    name: "model.step",
    startTimeMs: now - 1000,
  };
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    route = socket;
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as ObservabilityClientMessage;
      if (request.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: "traces",
          range: request.range,
          entries: [
            root,
            ...Array.from({ length: 2499 }, (_, index) => ({
              ...child,
              spanId: `child-${index}`,
            })),
          ],
        }),
      );
    });
  });
  await page.goto(`/${readProjectId()}/dashboard?tab=tracing`);
  await expect(page.locator(`#task-${traceId}`)).toBeVisible();
  route!.send(JSON.stringify({ type: "span", entry: child }));
  route!.send(
    JSON.stringify({
      type: "span",
      entry: { ...root, attributes: { "task.input": "updated loaded root" } },
    }),
  );
  await expect(page.locator(`#task-${traceId}`)).toContainText(
    "updated loaded root",
  );
});
