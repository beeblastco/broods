import { describe, expect, test } from "bun:test";
import type { ObservabilitySpanRow } from "../app/hooks/useObservabilityStream";
import { agentDebugPrompt } from "../app/lib/agentDebugPrompt";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

const root: ObservabilitySpanRow = {
  traceId: TRACE_ID,
  spanId: "00f067aa0ba902b7",
  name: "task",
  kind: "task",
  startTimeMs: Date.UTC(2026, 9, 15, 22, 58),
  endTimeMs: Date.UTC(2026, 9, 15, 22, 59),
  durationMs: 60_000,
  status: "error",
  agentId: "agent_123",
  conversationKey: "acct:a:agent:agent_123:conv-1",
  attributes: {
    "task.id": "evt-42",
    "model.input": "my secret question",
    "agent.environment": "OPENAI_API_KEY=sk-live",
  },
};

const base = { projectSlug: "demo", stageSlug: "development", root: root };

describe("agentDebugPrompt", () => {
  test("a failed task names its ids, error and the CLI command that reads it", () => {
    const prompt = agentDebugPrompt({
      ...base,
      status: "error",
      error: "Model provider returned 503",
    });

    expect(prompt).toStartWith(
      "A run of my Broods agent failed. Find out why it failed and fix it.",
    );
    for (const line of [
      "Project: demo",
      "Stage: development",
      "Agent: agent_123",
      "Task ID: evt-42",
      `Trace ID: ${TRACE_ID}`,
      "Conversation: acct:a:agent:agent_123:conv-1",
      "Started: 2026-10-15T22:58:00.000Z",
      "Error: Model provider returned 503",
    ]) {
      expect(prompt).toContain(`\n${line}\n`);
    }
    expect(prompt).toContain(
      `broods trace ${TRACE_ID} --project demo --stage development --json`,
    );
  });

  test("carries ids only, never the run's payloads", () => {
    const prompt = agentDebugPrompt({
      ...base,
      status: "ok",
      error: null,
    });

    expect(prompt).toStartWith("A run of my Broods agent finished. Audit it");
    expect(prompt).not.toContain("secret question");
    expect(prompt).not.toContain("sk-live");
    expect(prompt).not.toContain("Error:");
  });

  test("cuts a long error", () => {
    const prompt = agentDebugPrompt({
      ...base,
      status: "error",
      error: "x".repeat(2_000),
    });

    expect(prompt).toContain(`Error: ${"x".repeat(500)}…\n`);
  });
});
