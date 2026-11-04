import { describe, expect, test } from "bun:test";
import {
  auditSummaries,
  runSummaries,
  traceSteps,
} from "../src/observability-read.ts";
import type { ObservabilitySpanRow } from "../src/observability-contracts.ts";

const span = (over: Partial<ObservabilitySpanRow>): ObservabilitySpanRow => ({
  traceId: "t".repeat(32),
  spanId: "s",
  name: "agent.task",
  kind: "task",
  startTimeMs: 1000,
  endTimeMs: 2000,
  durationMs: 1000,
  status: "ok",
  ...over,
});

describe("what an agent reads", (): void => {
  test("audit is newest first, filtered, with no hash chain", (): void => {
    const rows = [
      {
        seq: 1,
        at: 1000,
        action: "run.completed",
        actor: { agentId: "a1", kind: "agent" },
        resource: { kind: "run", id: "acct:x:agent:a1:tg:1" },
        hash: "h1",
        prevHash: "",
      },
      {
        seq: 2,
        at: 2000,
        action: "synced",
        resource: { name: "app/dev" },
        hash: "h2",
        prevHash: "h1",
      },
      {
        seq: 3,
        at: 3000,
        action: "run.completed",
        actor: { agentId: "a2" },
        hash: "h3",
        prevHash: "h2",
      },
    ];

    const { events, matched } = auditSummaries(rows, {
      action: "run.completed",
      limit: 10,
    });

    expect(matched).toBe(2);
    expect(events.map((event): string | undefined => event.actor)).toEqual([
      "a2",
      "a1",
    ]);
    expect(JSON.stringify(events)).not.toContain("h1");
    expect(auditSummaries(rows, { agentId: "a1", limit: 10 }).matched).toBe(1);
  });

  test("a run is its root span, newest first, with its tokens and first words", (): void => {
    const runs = runSummaries(
      [
        span({ kind: "model.step", spanId: "child" }),
        span({ spanId: "old", startTimeMs: 1, agentId: "a1" }),
        span({
          spanId: "new",
          startTimeMs: 9,
          agentId: "a2",
          status: "error",
          error: "boom",
          attributes: {
            "task.input": "x".repeat(400),
            "usage.input_tokens": 7,
          },
        }),
      ],
      { limit: 10 },
    );

    expect(runs.map((run): string => run.status)).toEqual(["error", "ok"]);
    expect(runs[0]).toMatchObject({ error: "boom", inputTokens: 7 });
    expect(runs[0]?.input?.endsWith("[400 chars]")).toBe(true);
    expect(
      runSummaries([span({ agentId: "a1" })], { agentId: "a2", limit: 5 }),
    ).toEqual([]);
  });

  test("a trace reads in order, names tools, and cuts long payloads", (): void => {
    const steps = traceSteps([
      span({
        kind: "tool.call",
        name: "tool.call",
        startTimeMs: 5,
        attributes: { "tool.name": "bash", "tool.output": "y".repeat(2000) },
      }),
      span({
        kind: "model.step",
        name: "model.step",
        startTimeMs: 1,
        attributes: {
          "model.input_tokens": 3,
          "model.finish_reason": "tool-calls",
        },
      }),
    ]);

    expect(steps.map((step): string => step.name)).toEqual([
      "model.step",
      "bash",
    ]);
    expect(steps[0]).toMatchObject({ inputTokens: 3, finish: "tool-calls" });
    expect(steps[1]?.output?.endsWith("[2000 chars]")).toBe(true);
  });
});
