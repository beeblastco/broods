import { describe, expect, test } from "bun:test";
import { planFromQuery, type CopilotContext } from "../app/lib/copilotIntent";
import type { SearchItem } from "../app/lib/paletteSearch";

const SCHEDULER: SearchItem = {
  group: "Go to",
  id: "page:/scheduler",
  target: { href: "/p/scheduler", type: "navigate" },
  title: "Scheduler",
};

const TRIAGE: SearchItem = {
  group: "Nodes",
  id: "node:7",
  target: { nodeId: "7", type: "openNode" },
  title: "triage",
};

function context(overrides: Partial<CopilotContext> = {}): CopilotContext {
  return {
    crons: [{ id: "c1", name: "nightly-digest", status: "active" }],
    envNames: ["MAX_RETRIES"],
    items: [SCHEDULER, TRIAGE],
    liveCommands: new Set(["canvas.addAgent"]),
    ...overrides,
  };
}

describe("copilot intent", () => {
  test("refuses anything irreversible before it tries to plan it", () => {
    const plan = planFromQuery("deploy triage to production", context());

    expect(plan?.actions[0].type).toBe("blocked");
  });

  test("pausing a cron carries the before and after it is about to write", () => {
    const plan = planFromQuery("pause nightly-digest", context());

    expect(plan?.actions[0]).toMatchObject({
      change: { after: "paused", before: "active" },
      cronId: "c1",
      type: "setCronStatus",
    });
  });

  test("a cron already in the asked-for state plans nothing", () => {
    const plan = planFromQuery("pause nightly-digest", {
      ...context(),
      crons: [{ id: "c1", name: "nightly-digest", status: "paused" }],
    });

    expect(plan?.actions).toEqual([]);
    expect(plan?.summary).toContain("already paused");
  });

  test("an env var is normalised and reported as hidden when it already exists", () => {
    const plan = planFromQuery("set max_retries to 8", context());

    expect(plan?.actions[0]).toMatchObject({
      change: { after: "8", before: "set, hidden", field: "MAX_RETRIES" },
      name: "MAX_RETRIES",
      type: "setEnvVar",
      value: "8",
    });
  });

  test("a command the current page has not claimed is not offered", () => {
    expect(planFromQuery("add a sandbox", context())).toBeNull();
    expect(planFromQuery("add an agent", context())?.actions[0]).toMatchObject({
      commandId: "canvas.addAgent",
      type: "command",
    });
  });

  test("a canvas command is named the way the palette names it", () => {
    const live = { liveCommands: new Set(["canvas.fitView", "canvas.tidy"]) };

    expect(planFromQuery("fit the canvas", context(live))?.actions[0]).toEqual({
      commandId: "canvas.fitView",
      label: "Fit view",
      type: "command",
    });
    expect(planFromQuery("tidy the canvas", context(live))?.summary).toBe(
      "Tidy up",
    );
  });

  test("a navigation verb resolves through the same ranking the palette uses", () => {
    expect(
      planFromQuery("go to scheduler", context())?.actions[0],
    ).toMatchObject({
      href: "/p/scheduler",
      type: "navigate",
    });
    expect(planFromQuery("triage", context())?.actions[0]).toMatchObject({
      nodeId: "7",
      type: "openNode",
    });
  });

  test("a question is left for the model rather than guessed at", () => {
    expect(planFromQuery("why does triage keep failing", context())).toBeNull();
  });
});
