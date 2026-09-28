import { describe, expect, test } from "bun:test";
import type { ObservabilitySpanRow } from "../app/hooks/useObservabilityStream";
import {
  failureCause,
  foldSteps,
  groupSpans,
  matchesTaskQuery,
  parseTaskQuery,
  taskChannel,
} from "../app/(main)/[projectId]/dashboard/components/TracingPanel";

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

  test("nests a subagent's own steps and tool calls under its row", () => {
    const parent = root("parent", 1_000, 9_000, "ok", { "task.id": TASK_ID });
    const subagent = root("sub", 2_000, 5_000, "ok", {
      "parent.trace_id": "trace-parent",
    });
    subagent.kind = "subtask";
    const subStep = step("sub", 0, 2_100, 2_500);
    const subTool = child("sub", "bash", 2_200, "ok");
    subTool.parentSpanId = subStep.spanId;

    const [group] = groupSpans([parent, subagent, subStep, subTool]);

    expect(group.childrenByParent.get("parent")?.map((s) => s.spanId)).toEqual([
      "sub",
    ]);
    expect(group.childrenByParent.get("sub")?.map((s) => s.spanId)).toEqual([
      subStep.spanId,
    ]);
    expect(
      group.childrenByParent.get(subStep.spanId)?.map((s) => s.spanId),
    ).toEqual(["sub-bash"]);
  });
});

describe("foldSteps", () => {
  test("folds consecutive steps that each call the same one tool", () => {
    const steps = [3, 4, 5].map((number) =>
      step("run", number, number * 1_000, number * 1_000 + 400),
    );
    const other = step("run", 6, 7_000, 7_500);
    const children = new Map([
      ...steps.map((s): [string, ObservabilitySpanRow[]] => [
        s.spanId,
        [toolOf(s, "get_subagent_status")],
      ]),
      [other.spanId, [toolOf(other, "bash")]],
    ]);

    const items = foldSteps([...steps, other], children);

    expect(items).toHaveLength(2);
    const [fold, rest] = items;
    if (fold.type !== "fold") throw new Error("expected a fold");
    expect(fold.fold.label).toBe("step 4-6 get_subagent_status ×3");
    expect(fold.fold.steps).toEqual(steps);
    expect(fold.fold.span).toMatchObject({
      startTimeMs: 3_000,
      endTimeMs: 5_400,
      durationMs: 1_200,
      status: "ok",
    });
    expect(rest).toEqual({ type: "span", span: other });
  });

  test("marks a fold failed when one of its tool calls failed", () => {
    const steps = [0, 1].map((number) =>
      step("run", number, number * 1_000, number * 1_000 + 100),
    );
    const children = new Map(
      steps.map((s, index): [string, ObservabilitySpanRow[]] => [
        s.spanId,
        [
          {
            ...toolOf(s, "bash"),
            status: index === 1 ? "error" : "ok",
          },
        ],
      ]),
    );

    const [fold] = foldSteps(steps, children);
    if (fold.type !== "fold") throw new Error("expected a fold");
    expect(fold.fold.span.status).toBe("error");
  });

  test("does not fold steps whose tool calls carry no tool name", () => {
    const steps = [0, 1].map((number) =>
      step("run", number, number * 1_000, number * 1_000 + 100),
    );
    const children = new Map(
      steps.map((s): [string, ObservabilitySpanRow[]] => [
        s.spanId,
        [{ ...toolOf(s, "unnamed"), attributes: {} }],
      ]),
    );

    expect(foldSteps(steps, children).map((item) => item.type)).toEqual([
      "span",
      "span",
    ]);
  });

  test("leaves a lone step, mixed tools and interleaved spans unfolded", () => {
    const first = step("run", 0, 1_000, 1_100);
    const mixed = step("run", 1, 2_000, 2_100);
    const phase = { ...step("run", 2, 3_000, 3_100), kind: "phase" as const };
    const last = step("run", 3, 4_000, 4_100);
    const children = new Map<string, ObservabilitySpanRow[]>([
      [first.spanId, [toolOf(first, "bash")]],
      [mixed.spanId, [toolOf(mixed, "bash"), toolOf(mixed, "read")]],
      [last.spanId, [toolOf(last, "bash")]],
    ]);

    const items = foldSteps([first, mixed, phase, last], children);

    expect(items.map((item) => item.type)).toEqual([
      "span",
      "span",
      "span",
      "span",
    ]);
  });
});

describe("task search", () => {
  test("splits field tokens from free words, ignoring unknown and empty fields", () => {
    expect(
      parseTaskQuery("  Status:Failed tool:bash  hello foo:bar trace: "),
    ).toEqual({
      fields: [
        { field: "status", value: "failed" },
        { field: "tool", value: "bash" },
      ],
      text: "hello foo:bar",
    });
    expect(parseTaskQuery("conv:tg:42").fields).toEqual([
      { field: "conv", value: "tg:42" },
    ]);
  });

  test("ANDs every field with the free text", () => {
    const failed = root("run", 1_000, 2_000, "error", { "task.input": "hi" });
    failed.conversationKey = "tg:42";
    failed.agentId = "support-bot";
    failed.error = "Provider returned 429 Too Many Requests";
    const tool = child("run", "get_subagent_status", 1_200, "ok");
    const [group] = groupSpans([failed, tool]);
    const matches = (input: string): boolean =>
      matchesTaskQuery(group, parseTaskQuery(input));

    expect(matches("status:failed channel:telegram")).toBe(true);
    expect(matches("status:done")).toBe(false);
    expect(matches("tool:get_subagent_status")).toBe(true);
    expect(matches("tool:get_subagent")).toBe(false);
    expect(matches("error:rate_limit")).toBe(true);
    expect(matches("error:timeout")).toBe(false);
    expect(matches("error:too")).toBe(true);
    expect(matches("conv:tg:4 trace:trace-r agent:support")).toBe(true);
    expect(matches("agent:bot")).toBe(false);
    expect(matches("channel:slack")).toBe(false);
    expect(matches("status:error 429")).toBe(true);
    expect(matches("status:error nothing-here")).toBe(false);
  });
});

describe("task list line", () => {
  test("names the channel from the conversation key", () => {
    const task = root("run", 0, 1, "ok", {});
    const channelOf = (key: string | undefined): string =>
      taskChannel({ ...task, conversationKey: key });

    expect(channelOf("tg:1")).toBe("Telegram");
    // Stored keys are scoped to the account and agent.
    expect(channelOf("acct:a:agent:b:tg:7495331456")).toBe("Telegram");
    expect(channelOf("gh:owner/repo:pr:1")).toBe("GitHub");
    expect(channelOf("slack:T1:C1")).toBe("Slack");
    expect(channelOf("my-session")).toBe("API");
    expect(channelOf(undefined)).toBe("API");
    expect(taskChannel({ ...task, kind: "cron" })).toBe("Cron");
  });

  test("shortens the failure cause", () => {
    const failed = root("run", 0, 1, "error", {});
    const causeOf = (error: string): string | null =>
      failureCause(groupSpans([{ ...failed, error: error }])[0]);

    expect(causeOf("rate limit exceeded for model")).toBe("rate limit");
    expect(causeOf("x".repeat(50))).toBe(`${"x".repeat(40)}…`);
    expect(causeOf("boom")).toBe("boom");
    expect(failureCause(groupSpans([root("ok", 0, 1, "ok", {})])[0])).toBe(
      null,
    );
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

function step(
  runId: string,
  stepNumber: number,
  startTimeMs: number,
  endTimeMs: number,
): ObservabilitySpanRow {
  return {
    traceId: `trace-${runId}`,
    spanId: `${runId}-step-${stepNumber}`,
    parentSpanId: runId,
    name: "model.step",
    kind: "model.step",
    startTimeMs: startTimeMs,
    endTimeMs: endTimeMs,
    durationMs: endTimeMs - startTimeMs,
    status: "ok",
    attributes: { "agent.step_number": stepNumber },
  };
}

function toolOf(
  parent: ObservabilitySpanRow,
  toolName: string,
): ObservabilitySpanRow {
  return {
    ...parent,
    spanId: `${parent.spanId}-${toolName}`,
    parentSpanId: parent.spanId,
    name: "tool.call",
    kind: "tool.call",
    attributes: { "tool.name": toolName },
  };
}
