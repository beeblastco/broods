"use client";

import {
  CANVAS_EDGE_TYPES,
  CANVAS_NODE_TYPES,
} from "@/app/components/canvas/Canvas";
import { FIT_VIEW_OPTIONS } from "@/app/components/canvas/CanvasControl";
import { CanvasNoticeStrip } from "@/app/components/canvas/CanvasNotice";
import { InfraAnalysisProvider } from "@/app/components/canvas/InfraAnalysisContext";
import { CopilotDock } from "@/app/components/copilot/CopilotDock";
import {
  CopilotStateProvider,
  useProposedNodes,
  type CopilotMessage,
  type CopilotState,
} from "@/app/components/copilot/CopilotProvider";
import { DockApplyBar } from "@/app/components/copilot/DockApplyBar";
import { useHydrated } from "@/app/hooks/useHydrated";
import { proposalPlan } from "@/app/lib/agentDock";
import {
  changeKey,
  dockProposals,
  openProposal,
  type DockApply,
} from "@/app/lib/copilotActions";
import { analyzeCanvasInfra } from "@/app/lib/canvasRuntimeRefs";
import type { DockTracePart } from "@/app/lib/dockTrace";
import { withProposal } from "@/app/lib/proposedNodes";
import { Background, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useMemo, useState } from "react";

const SHA = "8d7ea8b41c0e2f7d9a1b3c5e7f9a0b1c2d3e4f5a";
const RUN = "https://github.test/acme/agents/actions/runs/1";

const NODES: Node[] = [
  fixtureNode("dock", "mcp", 0, 0),
  fixtureNode("broods", "agent", 240, 60),
  fixtureNode("box", "sandbox", 0, 180),
  fixtureNode("notes", "workspace", 240, 240),
];

const EDGES: Edge[] = ["dock", "box", "notes"].map((target) => ({
  id: `broods-${target}`,
  source: "broods",
  target: target,
}));

const ANALYSIS = analyzeCanvasInfra(NODES, EDGES);

const INDEX_BEFORE = `export const broods = defineAgent({
  name: "broods",
  mcps: [dock],
  workspaces: [notes],
});
`;

const PLAN = proposalPlan(
  {
    files: [
      {
        content: `import { defineMcp } from "broods";

export const deepwiki = defineMcp({
  name: "deepwiki",
  url: "https://mcp.deepwiki.com/mcp",
});
`,
        path: "broods/deepwiki.ts",
      },
      {
        content: INDEX_BEFORE.replace(
          "mcps: [dock],\n  workspaces: [notes],",
          "mcps: [dock, deepwiki],",
        ),
        path: "broods/index.ts",
      },
      { content: null, path: "broods/notes.ts" },
    ],
    message: "Connect DeepWiki to broods",
    nodes: [
      { change: "add", connectTo: "broods", kind: "mcp", name: "deepwiki" },
      { change: "remove", kind: "workspace", name: "notes" },
    ],
    summary: "Connects DeepWiki and drops the notes workspace.",
  },
  { crons: [], envNames: [], items: [], liveCommands: new Set() },
  {
    baseSha: "base",
    branch: "dev",
    files: [
      { content: INDEX_BEFORE, path: "broods/index.ts" },
      {
        content: 'export const notes = defineWorkspace({ name: "notes" });\n',
        path: "broods/notes.ts",
      },
    ],
    fullName: "acme/agents",
    omitted: 0,
  },
);

const TRACE: readonly DockTracePart[] = [
  {
    id: "r1",
    kind: "reasoning",
    text: "The user wants DeepWiki on broods. Check what broods has, then find DeepWiki's server.",
  },
  {
    endedAt: 1_420,
    id: "t1",
    input: { method: "GET", path: "/v1/agents/broods" },
    kind: "tool",
    name: "dock__broods_api",
    output: { mcps: ["dock"], name: "broods", workspaces: ["notes"] },
    startedAt: 1_100,
    title: "GET /v1/agents/broods",
  },
  {
    endedAt: 4_900,
    id: "t2",
    input: { query: "connect an MCP server" },
    kind: "tool",
    name: "dock__read_docs",
    output: "## MCP servers\n".padEnd(6_000, " defineMcp({ name, url })"),
    startedAt: 1_600,
    title: "read_docs",
  },
  {
    endedAt: 5_300,
    error: "fetch failed: 503",
    id: "t3",
    input: { url: "https://deepwiki.com/mcp" },
    kind: "tool",
    name: "web_fetch",
    startedAt: 5_000,
    title: "web_fetch",
  },
  {
    endedAt: 5_500,
    id: "t4",
    input: { path: "/p/scheduler" },
    kind: "tool",
    name: "dock__navigate",
    output: "ok",
    startedAt: 5_450,
    title: "Opened Scheduler",
  },
  {
    endedAt: 9_100,
    id: "t5",
    input: { summary: "Connects DeepWiki and drops the notes workspace." },
    kind: "tool",
    name: "dock__propose_changes",
    output: "ok",
    startedAt: 8_200,
    title: "Proposed changes",
  },
];

const MESSAGES: readonly CopilotMessage[] = [
  { id: "ask:you", role: "user", text: "connect deepwiki to broods" },
  {
    answeredAt: 9_400,
    id: "ask:broods",
    plan: PLAN ?? undefined,
    role: "broods",
    startedAt: 0,
    text: "DeepWiki's official server is `https://mcp.deepwiki.com/mcp`. Apply adds it to broods and removes notes. Its runs show on the [Scheduler](/ui-gallery?tab=dock-apply) and in the [DeepWiki docs](https://docs.devin.ai/work-with-devin/deepwiki-mcp).",
    trace: TRACE,
  },
];

const PHASES: Record<string, DockApply | null> = {
  proposed: null,
  applying: { phase: "applying", sha: SHA, startedAt: 0, runUrl: RUN },
  deployed: {
    finishedAt: 58_000,
    phase: "deployed",
    runUrl: RUN,
    sha: SHA,
    startedAt: 0,
  },
  failed: {
    error: "Error: defineMcp needs a url or a handler",
    phase: "failed",
    runUrl: RUN,
    sha: SHA,
    startedAt: 0,
  },
  discarded: { phase: "discarded" },
  verifying: { phase: "verifying", sha: SHA, startedAt: 0 },
  "out-of-sync": { phase: "discarded" },
};

// The dock's proposal in each phase, driven by the real bar, chat line and canvas drawing.
export function DockApplyStandIn(): React.JSX.Element {
  const hydrated = useHydrated();
  const [apply, setApply] = useState<DockApply | null>(null);
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set());
  const [outOfSync, setOutOfSync] = useState(false);

  const record = (next: DockApply): void =>
    setApply(
      next.phase === "applying" || next.phase === "verifying"
        ? { ...next, startedAt: Date.now() - 41_000 }
        : next,
    );
  const proposals = dockProposals(
    MESSAGES,
    dropped,
    new Set(),
    apply ? { "ask:broods": apply } : {},
    [],
    "Development",
  );
  // Rebuilt every render on purpose: a fixture gains nothing from a stable identity.
  const copilot: CopilotState = {
    applyProposal: () => record({ phase: "applying", runUrl: RUN, sha: SHA }),
    ask: () => {},
    completed: new Set(),
    discardProposal: () => setApply({ phase: "discarded", sha: apply?.sha }),
    drift: outOfSync
      ? {
          reason: "dev has commits the stored source does not.",
          syncing: false,
        }
      : null,
    dropChange: (messageId, index, path) =>
      setDropped((prev) =>
        new Set(prev).add(changeKey(messageId, index, path)),
      ),
    isOpen: true,
    items: [],
    messages: MESSAGES,
    proposal: openProposal(MESSAGES, proposals),
    proposals: proposals,
    revertProposal: () => {},
    runAction: () => {},
    setOpen: () => {},
    syncStage: () => {},
    wakeIndex: () => {},
  };

  return (
    <main
      className="flex h-screen flex-col"
      data-hydrated={hydrated ? "true" : undefined}
    >
      <CopilotStateProvider value={copilot}>
        <div className="flex gap-1 p-2">
          {Object.entries(PHASES).map(([name, next]) => (
            <button
              key={name}
              type="button"
              data-set-phase={name}
              className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs"
              onClick={() => {
                setOutOfSync(name === "out-of-sync");
                if (next) record(next);
                else setApply(null);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <FixtureCanvas />
          </div>
          <CopilotDock />
        </div>
      </CopilotStateProvider>
    </main>
  );
}

function FixtureCanvas(): React.JSX.Element {
  const proposed = useProposedNodes();
  const drawn = useMemo(
    () => withProposal(NODES, EDGES, proposed.nodes, proposed.failed),
    [proposed],
  );

  return (
    <InfraAnalysisProvider value={ANALYSIS}>
      <ReactFlow
        nodes={drawn.nodes}
        edges={drawn.edges}
        nodeTypes={CANVAS_NODE_TYPES}
        edgeTypes={CANVAS_EDGE_TYPES}
        colorMode="dark"
        fitViewOptions={FIT_VIEW_OPTIONS}
        nodesDraggable={false}
        onInit={(instance) => {
          void instance.fitView(FIT_VIEW_OPTIONS);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          bgColor="#000"
          color="rgba(255,255,255,0.3)"
          gap={16}
          size={2}
        />
        <CanvasNoticeStrip>
          <DockApplyBar />
        </CanvasNoticeStrip>
      </ReactFlow>
    </InfraAnalysisProvider>
  );
}

function fixtureNode(id: string, type: string, x: number, y: number): Node {
  return {
    data: { label: id, status: "idle" },
    id: id,
    position: { x: x, y: y },
    type: type,
  };
}
