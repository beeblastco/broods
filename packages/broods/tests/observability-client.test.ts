import { afterEach, expect, test } from "bun:test";
import { subscribeObservabilityLogs } from "../src/observability-client.ts";
import type { ObservabilityLogEntry, ObservabilityServerMessage } from "../src/observability-contracts.ts";

class FakeObservabilitySocket {
  static instances: FakeObservabilitySocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeObservabilitySocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  emit(message: ObservabilityServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  FakeObservabilitySocket.instances = [];
  globalThis.WebSocket = originalWebSocket;
});

test("reconnects transient log sockets and de-duplicates overlap backfill", async () => {
  globalThis.WebSocket = FakeObservabilitySocket as unknown as typeof WebSocket;
  const controller = new AbortController();
  const stream = subscribeObservabilityLogs(
    { baseUrl: "https://app.example", apiKey: "secret-key", project: "demo", environment: "development" },
    { backfill: 100, signal: controller.signal },
  );
  const firstEntry: ObservabilityLogEntry = {
    ts: 1,
    level: "INFO",
    eventType: "agent.started",
    message: "first",
  };
  const secondEntry: ObservabilityLogEntry = {
    ts: 2,
    level: "INFO",
    eventType: "agent.finished",
    message: "second",
  };

  const first = stream.next();
  await Bun.sleep(0);
  FakeObservabilitySocket.instances[0]!.emit({ type: "log", entry: firstEntry });
  expect((await first).value).toEqual(firstEntry);

  const second = stream.next();
  FakeObservabilitySocket.instances[0]!.close(1006, "gateway restart");
  await Bun.sleep(550);
  expect(FakeObservabilitySocket.instances).toHaveLength(2);
  FakeObservabilitySocket.instances[1]!.emit({
    type: "backfill",
    stream: "logs",
    entries: [firstEntry, secondEntry],
  });
  expect((await second).value).toEqual(secondEntry);

  controller.abort();
  await stream.return(undefined);
});

test("does not include the runtime key in connection errors", async () => {
  globalThis.WebSocket = FakeObservabilitySocket as unknown as typeof WebSocket;
  const stream = subscribeObservabilityLogs(
    { baseUrl: "https://app.example", apiKey: "do-not-leak", project: "demo", environment: "development" },
  );
  const result = stream.next();
  await Bun.sleep(0);
  FakeObservabilitySocket.instances[0]!.emit({ type: "error", error: "Unauthorized" });

  await expect(result).rejects.toThrow("Unauthorized");
  await expect(result).rejects.not.toThrow("do-not-leak");
});
