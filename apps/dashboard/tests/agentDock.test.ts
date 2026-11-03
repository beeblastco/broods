import { describe, expect, test } from "bun:test";
import { dockPrompt, proposalPlan } from "../app/lib/agentDock";
import { actionTier, pendingChanges } from "../app/lib/copilotActions";
import { planFromQuery } from "../app/lib/copilotIntent";
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
  test("the prompt names what is on screen, how it connects and where it deploys from", () => {
    const prompt = dockPrompt("what runs at night?", CONTEXT, {
      codeNodes: ["broods"],
      connections: ["broods → dock"],
      project: "broods",
      repo: "acme/agents (Production from main)",
      stage: "Development",
    });

    expect(prompt).toStartWith("what runs at night?");
    expect(prompt).toContain("Project: broods, stage: Development");
    expect(prompt).toContain("Deploys from GitHub acme/agents");
    expect(prompt).toContain("- Go to: Scheduler");
    expect(prompt).toContain("- Connected: broods → dock");
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

  test("a proposed new node waits for its press instead of landing on the canvas", () => {
    const plan = proposalPlan(
      { steps: ["add an mcp"], summary: "" },
      { ...CONTEXT, liveCommands: new Set(["canvas.addMcp"]) },
    );

    expect(plan?.actions.map(actionTier)).toEqual(["approval"]);
  });

  test("input the tool schema does not allow proposes nothing", () => {
    expect(proposalPlan({ steps: "pause it" }, CONTEXT)).toBeNull();
  });

  const WIRED: CopilotContext = {
    ...CONTEXT,
    items: [
      ...CONTEXT.items,
      {
        detail: "agent",
        group: "Nodes",
        id: "node:1",
        target: { nodeId: "1", type: "openNode" },
        title: "broods",
      },
      {
        detail: "mcp",
        group: "Nodes",
        id: "node:2",
        target: { nodeId: "2", type: "openNode" },
        title: "search",
      },
    ],
  };

  test("connect puts the agent at the source end, whichever way it is asked", () => {
    expect(
      planFromQuery("connect search to broods", WIRED)?.actions,
    ).toMatchObject([
      { source: "broods", target: "search", type: "connectNodes" },
    ]);
  });

  test("an MCP added with its URL is wired to the named agent and waits for Apply", () => {
    const plan = planFromQuery(
      "add mcp firecrawl at https://mcp.firecrawl.dev/mcp to broods",
      WIRED,
    );

    expect(plan?.actions).toMatchObject([
      {
        agent: "broods",
        name: "firecrawl",
        type: "addMcp",
        url: "https://mcp.firecrawl.dev/mcp",
      },
    ]);
    expect(plan?.actions.map(actionTier)).toEqual(["approval"]);
  });

  test("a resource added to an agent lands wired to it, and a code-defined one is refused", () => {
    expect(
      planFromQuery("add a workspace to broods", WIRED)?.actions,
    ).toMatchObject([
      { agent: "broods", nodeType: "workspace", type: "addNode" },
    ]);
    expect(
      planFromQuery("add sandbox to broods", {
        ...WIRED,
        lockedNodes: new Set(["broods"]),
      })?.actions.map((action) => action.type),
    ).toEqual(["blocked"]);
  });

  test("proposed file edits become one commit to the stage's branch", () => {
    const plan = proposalPlan(
      {
        files: [{ content: "a\nb\nc", path: "broods/index.ts" }],
        message: "Add firecrawl",
        summary: "",
      },
      CONTEXT,
      {
        baseSha: "abc",
        branch: "dev",
        files: [{ content: "a", path: "broods/index.ts" }],
        fullName: "acme/agents",
        omitted: 0,
      },
    );

    expect(plan?.actions).toMatchObject([
      {
        baseSha: "abc",
        branch: "dev",
        label: "Commit to dev: Add firecrawl",
        type: "commitFiles",
      },
    ]);
    const [action] = plan?.actions ?? [];
    expect(action?.type === "commitFiles" ? action.files[0].patch : []).toEqual(
      ["@@ 1,1 → 1,3", " a", "+b", "+c"],
    );
  });

  test("a code-defined node says so on its own line of the prompt", () => {
    const prompt = dockPrompt("hi", WIRED, {
      codeNodes: ["broods"],
      connections: [],
    });

    expect(prompt).toContain(
      "- Nodes: broods (agent; defined in code, the canvas cannot change it)",
    );
    expect(prompt).toContain("- Nodes: search (mcp)");
  });

  test("a canvas step that touches a code-defined node is refused with the way to do it", () => {
    const plan = planFromQuery("connect search to broods", {
      ...WIRED,
      lockedNodes: new Set(["broods"]),
    });

    expect(plan?.actions).toMatchObject([
      { reason: expect.stringContaining("broods/ files"), type: "blocked" },
    ]);
  });

  test("an MCP aimed at a node that is not an agent is refused, never added blank", () => {
    const plan = planFromQuery(
      "add mcp docs at https://mcp.example.com/mcp to search",
      WIRED,
    );

    expect(plan?.actions).toMatchObject([
      { reason: "search is not an agent on this canvas.", type: "blocked" },
    ]);
  });

  test("only writes still waiting reach the tray", () => {
    const plan = planFromQuery("pause nightly-digest", CONTEXT) ?? undefined;
    const navigate = planFromQuery("go to scheduler", CONTEXT) ?? undefined;
    const plans = [
      { id: "a", plan: plan },
      { id: "b", plan: navigate },
      { id: "c", plan: plan },
    ];

    expect(
      pendingChanges(plans, new Set(["c:0"])).map((change) => change.messageId),
    ).toEqual(["a"]);
  });

  test("proposed files with no readable repo stay visible as blocked", () => {
    const plan = proposalPlan(
      { files: [{ content: "x", path: "broods/index.ts" }], summary: "" },
      CONTEXT,
    );

    expect(plan?.actions).toMatchObject([
      { reason: expect.stringContaining("could not be read"), type: "blocked" },
    ]);
  });
});
