import { describe, expect, test } from "bun:test";
import { dockPrompt, proposalPlan } from "../app/lib/agentDock";
import type { CopilotContext } from "../app/lib/copilotIntent";

const CONTEXT: CopilotContext = {
  crons: [{ id: "c1", name: "nightly-digest", status: "active" }],
  envNames: ["MAX_RETRIES"],
  items: [
    {
      group: "Go to",
      id: "page:/scheduler",
      target: { href: "/p/scheduler", type: "navigate" },
      title: "Scheduler",
    },
  ],
  liveCommands: new Set(),
};

describe("agent dock", () => {
  test("the prompt names what is on screen and no ids", () => {
    const prompt = dockPrompt("what runs at night?", CONTEXT);

    expect(prompt).toStartWith("what runs at night?");
    expect(prompt).toContain("Cron: nightly-digest (active)");
    expect(prompt).toContain("Env var on this stage: MAX_RETRIES");
    expect(prompt).not.toContain("c1");
  });

  test("proposed steps resolve through the planner, with its before and after", () => {
    const plan = proposalPlan(
      { steps: ["pause nightly-digest"], summary: "Pause the digest." },
      CONTEXT,
    );

    expect(plan?.summary).toBe("Pause the digest.");
    expect(plan?.actions).toMatchObject([
      {
        change: { after: "paused", before: "active" },
        cronId: "c1",
        type: "setCronStatus",
      },
    ]);
  });

  test("a step the planner refuses or cannot find stays visible as blocked", () => {
    const plan = proposalPlan(
      { steps: ["delete nightly-digest", "pause weekly-report"], summary: "" },
      CONTEXT,
    );

    expect(plan?.actions.map((action) => action.type)).toEqual([
      "blocked",
      "blocked",
    ]);
  });

  test("input the tool schema does not allow proposes nothing", () => {
    expect(proposalPlan({ steps: "pause it" }, CONTEXT)).toBeNull();
  });
});
