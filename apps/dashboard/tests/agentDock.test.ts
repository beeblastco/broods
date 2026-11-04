import { describe, expect, test } from "bun:test";
import { dockPrompt, proposalPlan } from "../app/lib/agentDock";
import {
  actionTier,
  applyStatus,
  changeKey,
  dockProposals,
  openProposal,
  proposedNodes,
} from "../app/lib/copilotActions";
import { withProposal } from "../app/lib/proposedNodes";
import { planFromQuery } from "../app/lib/copilotIntent";
import type { CopilotContext } from "../app/lib/copilotIntent";

const REPO = {
  baseSha: "abc",
  branch: "dev",
  files: [{ content: "a", path: "broods/index.ts" }],
  fullName: "acme/agents",
  omitted: 0,
  viaPullRequest: false,
};

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
        viaPullRequest: false,
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

  test("a change to a stage that deploys through pull requests says so", () => {
    const plan = proposalPlan(
      {
        files: [{ content: "a", path: "broods/index.ts" }],
        message: "Add firecrawl",
        summary: "",
      },
      CONTEXT,
      {
        baseSha: "abc",
        branch: "main",
        files: [],
        fullName: "acme/agents",
        omitted: 0,
        viaPullRequest: true,
      },
    );

    expect(plan?.actions[0]?.label).toBe(
      "Pull request into main: Add firecrawl",
    );
  });

  test("an edit to a file the agent was not shown is blocked when the read was partial", () => {
    const plan = proposalPlan(
      {
        files: [{ content: "x", path: "broods/other.ts" }],
        message: "",
        summary: "",
      },
      CONTEXT,
      {
        baseSha: "abc",
        branch: "dev",
        files: [{ content: "a", path: "broods/index.ts" }],
        fullName: "acme/agents",
        omitted: 3,
        viaPullRequest: false,
      },
    );

    expect(plan?.actions.map((action) => action.type)).toEqual(["blocked"]);
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

  test("each answer with a write is one proposal; dropped files leave its commit", () => {
    const pause = planFromQuery("pause nightly-digest", CONTEXT) ?? undefined;
    const navigate = planFromQuery("go to scheduler", CONTEXT) ?? undefined;
    const commit = proposalPlan(
      {
        files: [
          { content: "a", path: "broods/a.ts" },
          { content: "b", path: "broods/b.ts" },
        ],
        message: "Add a and b",
        summary: "",
      },
      CONTEXT,
      REPO,
    );
    const messages = [
      { id: "a", plan: pause },
      { id: "b", plan: navigate },
      { id: "c", plan: commit ?? undefined },
    ];

    const proposals = dockProposals(
      messages,
      new Set([changeKey("c", 0, "broods/a.ts")]),
      { a: { phase: "discarded" } },
      [],
    );

    expect([...proposals.keys()]).toEqual(["a", "c"]);
    const open = openProposal(messages, proposals);
    expect(open?.title).toBe("Add a and b");
    expect(
      open?.changes.flatMap(({ action }) =>
        action.type === "commitFiles"
          ? action.files.map((file) => file.path)
          : [],
      ),
    ).toEqual(["broods/b.ts"]);
  });

  test("a commit follows its GitHub run to deployed or failed, in the chat's words", () => {
    const commit = proposalPlan(
      { files: [{ content: "a", path: "broods/a.ts" }], summary: "" },
      CONTEXT,
      REPO,
    );
    const messages = [{ id: "m", plan: commit ?? undefined }];
    const deploy = {
      branch: "dev",
      committedAt: 0,
      messageId: "m",
      runUrl: "https://github.test/run/1",
      sha: "8d7ea8b41c",
      url: "https://github.test/commit/8d7ea8b41c",
    };
    const status = (state: "deployed" | "deploying" | "failed"): string => {
      const proposal = dockProposals(
        messages,
        new Set(),
        { m: { phase: "applying", sha: "8d7ea8b41c", startedAt: 1_000 } },
        [
          {
            ...deploy,
            conclusion: "timed_out",
            finishedAt: 43_000,
            state: state,
          },
        ],
      ).get("m");

      return proposal ? applyStatus(proposal).text : "";
    };

    expect(status("deploying")).toBe("Committed 8d7ea8b to dev. Deploying.");
    expect(status("deployed")).toBe("Deployed in 42 s.");
    expect(status("failed")).toBe("Deploy failed: the run timed out.");
  });

  test("a file with null content is deleted, its whole content shown removed", () => {
    const plan = proposalPlan(
      {
        files: [{ content: null, path: "broods/index.ts" }],
        message: "Remove it",
        summary: "",
      },
      CONTEXT,
      REPO,
    );

    const [action] = plan?.actions ?? [];
    expect(action?.type === "commitFiles" ? action.files[0] : null).toEqual({
      content: null,
      patch: ["@@ 1,1 → 1,0", "-a"],
      path: "broods/index.ts",
    });
    expect(
      proposalPlan(
        { files: [{ content: null, path: "broods/gone.ts" }], summary: "" },
        CONTEXT,
        REPO,
      )?.actions.map((step) => step.type),
    ).toEqual(["blocked"]);
  });

  test("proposed nodes draw dashed beside what they connect to, and leave once deployed", () => {
    const plan = proposalPlan(
      {
        files: [{ content: "a", path: "broods/a.ts" }],
        nodes: [
          { change: "add", connectTo: "broods", kind: "mcp", name: "deepwiki" },
          { change: "remove", kind: "workspace", name: "notes" },
        ],
        summary: "",
      },
      CONTEXT,
      REPO,
    );
    const messages = [{ id: "m", plan: plan ?? undefined }];
    const canvas = [
      {
        data: { label: "broods" },
        id: "1",
        position: { x: 0, y: 0 },
        type: "agent",
      },
      {
        data: { label: "notes" },
        id: "2",
        position: { x: 0, y: 200 },
        type: "workspace",
      },
    ];
    const nodesFor = (
      phase: "deployed" | "proposed",
    ): ReturnType<typeof proposedNodes> =>
      proposedNodes(
        dockProposals(
          messages,
          new Set(),
          phase === "proposed" ? {} : { m: { phase: phase } },
          [],
        ).get("m") ?? null,
      );

    const drawn = withProposal(canvas, [], nodesFor("proposed"), false);
    expect(drawn.nodes.map((node) => [node.id, node.data.proposal])).toEqual([
      ["1", undefined],
      ["2", "remove"],
      ["proposed:deepwiki", undefined],
    ]);
    expect(drawn.edges).toMatchObject([
      { source: "1", target: "proposed:deepwiki" },
    ]);
    expect(nodesFor("deployed")).toEqual([]);
  });

  test("a proposed node can connect to a proposed agent listed after it", () => {
    const drawn = withProposal(
      [],
      [],
      [
        { change: "add", connectTo: "helper", kind: "mcp", name: "search" },
        { change: "add", kind: "agent", name: "helper" },
      ],
      false,
    );

    expect(drawn.edges).toMatchObject([
      { source: "proposed:helper", target: "proposed:search" },
    ]);
  });

  test("a malformed node list drops the nodes, not the proposal", () => {
    const plan = proposalPlan(
      { nodes: [{ kind: "cron", name: "x" }], summary: "Hi." },
      CONTEXT,
    );

    expect(plan).toMatchObject({ actions: [], nodes: [], summary: "Hi." });
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
