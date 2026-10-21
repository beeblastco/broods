import { describe, expect, test } from "bun:test";
import type { ObservabilitySpanRow } from "../app/hooks/useObservabilityStream";
import {
  axisTicks,
  failureCause,
  foldSteps,
  groupSpans,
  matchesTaskQuery,
  runIssues,
  spanIssue,
  TASK_QUERY_FIELDS,
  taskChannel,
  type TaskQuery,
} from "../app/(main)/[projectId]/dashboard/components/TracingPanel";
import { parseQuery } from "../app/lib/queryTokens";

const parseTaskQuery = (input: string): TaskQuery =>
  parseQuery(input, TASK_QUERY_FIELDS);

const TASK_ID = "acct:a:agent:b:tg:1:msg-9";

describe("groupSpans", () => {
  test("folds an answer's run into the task that asked, with the wait between", () => {
    const asked = root("asked", 1_000, 5_000, "needs_input", {
      "task.id": TASK_ID,
      "task.waiting_on": "question",
      "task.questions": "Which stage?\n1. dev\n2. prod",
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
      attributes: {
        "phase.name": "needs input · question",
        "task.questions": "Which stage?\n1. dev\n2. prod",
      },
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

  test("lists a subagent as its own run under the task, one line in the task's rows", () => {
    const parent = root("parent", 1_000, 9_000, "ok", { "task.id": TASK_ID });
    const subagent = root("sub", 2_000, 5_000, "ok", {
      "parent.trace_id": "trace-parent",
    });
    subagent.kind = "subtask";
    const subStep = step("sub", 0, 2_100, 2_500);
    const subTool = child("sub", "bash", 2_200, "ok");
    subTool.parentSpanId = subStep.spanId;

    const [group, ...rest] = groupSpans([parent, subagent, subStep, subTool]);

    expect(rest).toHaveLength(0);
    expect(group.childrenByParent.get("parent")?.map((s) => s.spanId)).toEqual([
      "sub",
    ]);
    expect(group.childrenByParent.get("sub")).toBeUndefined();
    expect(group.subagents.map((s) => s.root.spanId)).toEqual(["sub"]);
    const [run] = group.subagents;
    expect(run.parentTraceId).toBe("trace-parent");
    expect(run.childrenByParent.get("sub")?.map((s) => s.spanId)).toEqual([
      subStep.spanId,
    ]);
    expect(
      run.childrenByParent.get(subStep.spanId)?.map((s) => s.spanId),
    ).toEqual(["sub-bash"]);
  });

  test("lists a subagent's subagent flat under the task, in start order", () => {
    const parent = root("parent", 1_000, 9_000, "ok", { "task.id": TASK_ID });
    const first = root("first", 2_000, 6_000, "ok", {
      "parent.trace_id": "trace-parent",
    });
    first.kind = "subtask";
    const nested = root("nested", 3_000, 4_000, "ok", {
      "parent.trace_id": "trace-first",
    });
    nested.kind = "subtask";
    const second = root("second", 5_000, 8_000, "ok", {
      "parent.trace_id": "trace-parent",
    });
    second.kind = "subtask";

    const [group, ...rest] = groupSpans([second, nested, parent, first]);

    expect(rest).toHaveLength(0);
    expect(group.subagents.map((s) => s.root.spanId)).toEqual([
      "first",
      "nested",
      "second",
    ]);
    expect(group.childrenByParent.get("parent")?.map((s) => s.spanId)).toEqual([
      "first",
      "second",
    ]);
    const [run] = group.subagents;
    expect(run.childrenByParent.get("first")?.map((s) => s.spanId)).toEqual([
      "nested",
    ]);
  });

  test("keeps a subagent of an orphan under the orphan, not the other way round", () => {
    const orphan = root("orphan", 1_000, 5_000, "ok", {
      "parent.trace_id": "trace-missing",
    });
    orphan.kind = "subtask";
    const child = root("child", 2_000, 3_000, "ok", {
      "parent.trace_id": "trace-orphan",
    });
    child.kind = "subtask";

    const [group, ...rest] = groupSpans([child, orphan]);

    expect(rest).toHaveLength(0);
    expect(group.root.spanId).toBe("orphan");
    expect(group.subagents.map((s) => s.root.spanId)).toEqual(["child"]);
  });

  test("lists a subagent whose parent never arrived on its own", () => {
    const orphan = root("orphan", 2_000, 5_000, "ok", {
      "parent.trace_id": "trace-missing",
    });
    orphan.kind = "subtask";

    const [group, ...rest] = groupSpans([orphan]);

    expect(rest).toHaveLength(0);
    expect(group.root.spanId).toBe("orphan");
    expect(group.subagents).toHaveLength(0);
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

  test("matches a task on what its subagents ran", () => {
    const parent = root("parent", 1_000, 9_000, "ok", { "task.id": TASK_ID });
    const subagent = root("sub", 2_000, 5_000, "ok", {
      "parent.trace_id": "trace-parent",
    });
    subagent.kind = "subtask";
    subagent.agentId = "researcher";
    const subTool = child("sub", "web_search", 2_200, "ok");
    const [group] = groupSpans([parent, subagent, subTool]);
    const matches = (input: string): boolean =>
      matchesTaskQuery(group, parseTaskQuery(input));

    expect(matches("tool:web_search")).toBe(true);
    expect(matches("agent:researcher")).toBe(true);
    expect(matches("trace:trace-sub")).toBe(true);
    expect(matches("tool:bash")).toBe(false);
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

describe("waterfall issues", () => {
  test("reads a failure and a retried model call off their spans", () => {
    const failed = { ...child("run", "bash", 2_000, "error"), error: "boom" };
    const retried = {
      ...step("run", 0, 1_000, 5_000),
      attributes: {
        "model.attempts": 3,
        "model.retry_wait_ms": 1_500,
        "model.attempt_errors": '["429 rate limited"]',
      },
    };

    expect(spanIssue(failed)).toEqual({
      atMs: 2_100,
      level: "error",
      label: "Failed",
      text: "boom",
    });
    expect(spanIssue(retried)).toEqual({
      atMs: 2_500,
      level: "warn",
      label: "Retried 2×",
      text: "429 rate limited",
    });
    expect(spanIssue(step("run", 1, 0, 1))).toBe(null);
  });

  test("counts a rate limited tool's retries", () => {
    const tool = {
      ...child("run", "search", 1_000, "ok"),
      attributes: { "tool.retry.count": 2, "tool.retry.wait_ms": 400 },
    };

    expect(spanIssue(tool)).toMatchObject({
      atMs: 1_000,
      level: "warn",
      label: "Retried 2×",
    });
  });

  test("lists a run's issues in time order and what sits under each span", () => {
    const task = root("run", 0, 10_000, "ok", {});
    const first = step("run", 0, 1_000, 4_000);
    const late = { ...toolOf(first, "bash"), status: "error" as const };
    const early = {
      ...child("run", "search", 500, "ok"),
      attributes: { "tool.retry.count": 1, "tool.retry.wait_ms": 100 },
    };

    const [group] = groupSpans([task, first, late, early]);
    const issues = runIssues(group);

    expect(issues.all.map(({ span }) => span.spanId)).toEqual([
      "run-search",
      "run-step-0-bash",
    ]);
    // The failed tool sits under its step, which a click must open.
    expect(issues.all.map(({ path }) => path)).toEqual([
      [],
      [{ key: "trace-run:run-step-0", startsOpen: true }],
    ]);
    expect(issues.below.get("run")).toHaveLength(2);
    expect(issues.below.get("run-step-0")).toHaveLength(1);
    expect(issues.below.get("run-step-0-bash")).toEqual([]);
  });

  test("a first pass that failed is not an issue once a continued pass went through", () => {
    const failed = {
      ...root("first", 0, 1_000, "error", { "task.id": TASK_ID }),
      error: "rate limited",
    };
    const continued = root("again", 5_000, 6_000, "ok", {
      "task.id": `${TASK_ID}:continue`,
      "task.root_id": TASK_ID,
    });

    const [recovered] = groupSpans([failed, continued]);
    const [stillFailed] = groupSpans([failed]);

    expect(runIssues(recovered).all).toEqual([]);
    expect(runIssues(stillFailed).own.get("first")?.label).toBe("Failed");
  });

  test("a run that failed mid tool call is one failure, at the tool", () => {
    // Core closes the open step and tool with the run's error when it fails.
    const failed = (span: ObservabilitySpanRow): ObservabilitySpanRow => ({
      ...span,
      status: "error",
      error: "invalid x-api-key",
    });
    const task = failed(root("run", 0, 5_000, "error", {}));
    const open = failed(step("run", 0, 1_000, 5_000));
    const tool = failed(toolOf(open, "bash"));

    const issues = runIssues(groupSpans([task, open, tool])[0]);

    expect(issues.all.map(({ span }) => span.spanId)).toEqual([
      "run-step-0-bash",
    ]);
    expect(issues.own.has("run")).toBe(false);
    expect(issues.below.get("run")).toHaveLength(1);
  });

  test("steps the time axis so it shows at most four ticks", () => {
    expect(axisTicks(12_000)).toEqual([0, 5_000, 10_000]);
    expect(axisTicks(82_000)).toEqual([0, 30_000, 60_000]);
    expect(axisTicks(400)).toEqual([0, 200, 400]);
    // A run that waited three days on a person steps in whole hours.
    expect(axisTicks(72 * 3_600_000)).toEqual(
      [0, 24, 48, 72].map((hours) => hours * 3_600_000),
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
