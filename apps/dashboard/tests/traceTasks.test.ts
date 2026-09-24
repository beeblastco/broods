import { describe, expect, test } from "bun:test";
import type { ObservabilitySpanRow } from "../app/hooks/useObservabilityStream";
import { groupSpans } from "../app/(main)/[projectId]/dashboard/components/TracingPanel";

const TASK_ID = "acct:a:agent:b:tg:1:msg-9";

describe("groupSpans", () => {
  test("folds an answer's run into the task that asked, with the wait between", () => {
    const asked = root("asked", 1_000, 5_000, "needs_input", {
      "task.id": TASK_ID,
      "task.waiting_on": "question",
    });
    const resumed = root("resumed", 45_000, 49_000, "ok", {
      "task.id": `${TASK_ID}:async-question:async_tool_1:async-tools`,
      "task.root_id": TASK_ID,
    });
    const failedTool = child("asked", "bash", 2_000, "error");

    const [group, ...rest] = groupSpans([resumed, failedTool, asked]);

    expect(rest).toHaveLength(0);
    expect(group.root.spanId).toBe("asked");
    expect(group.status).toBe("ok");
    expect(group.issueCount).toBe(1);
    const nested = group.childrenByParent.get("asked") ?? [];
    expect(nested.map((span) => span.spanId)).toEqual([
      "asked-bash",
      "asked:wait",
      "resumed",
    ]);
    expect(nested[1]).toMatchObject({
      status: "needs_input",
      startTimeMs: 5_000,
      endTimeMs: 45_000,
      attributes: { "phase.name": "needs input · question" },
    });
  });

  test("keeps a task that is still waiting on its subagent as waiting", () => {
    const parent = root("parent", 1_000, 3_000, "ok", { "task.id": TASK_ID });
    const subagent = root("sub", 2_000, 2_000, "running", {
      "parent.trace_id": "trace-parent",
    });
    subagent.kind = "subtask";
    subagent.startTimeMs = Date.now();

    const [group, ...rest] = groupSpans([parent, subagent]);

    expect(rest).toHaveLength(0);
    expect(group.status).toBe("waiting");
    expect(group.childrenByParent.get("parent")?.[0]?.spanId).toBe("sub");
  });
});

function child(
  runId: string,
  toolName: string,
  startTimeMs: number,
  status: ObservabilitySpanRow["status"],
): ObservabilitySpanRow {
  return {
    traceId: `trace-${runId}`,
    spanId: `${runId}-${toolName}`,
    parentSpanId: runId,
    name: "tool.call",
    kind: "tool.call",
    startTimeMs: startTimeMs,
    endTimeMs: startTimeMs + 100,
    durationMs: 100,
    status: status,
    attributes: { "tool.name": toolName },
  };
}

function root(
  runId: string,
  startTimeMs: number,
  endTimeMs: number,
  status: ObservabilitySpanRow["status"],
  attributes: Record<string, unknown>,
): ObservabilitySpanRow {
  return {
    traceId: `trace-${runId}`,
    spanId: runId,
    name: "agent.task",
    kind: "task",
    startTimeMs: startTimeMs,
    endTimeMs: endTimeMs,
    durationMs: endTimeMs - startTimeMs,
    status: status,
    attributes: attributes,
  };
}
