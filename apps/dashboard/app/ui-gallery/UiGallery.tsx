"use client";

import {
  CANVAS_EDGE_TYPES,
  CANVAS_NODE_TYPES,
  CONNECTION_RADIUS,
} from "@/app/components/canvas/Canvas";
import {
  CanvasControls,
  FIT_VIEW_OPTIONS,
} from "@/app/components/canvas/CanvasControl";
import {
  CanvasFramesProvider,
  type CanvasFramesValue,
} from "@/app/components/canvas/CanvasFramesContext";
import {
  CanvasSaveStatus,
  type CanvasSaveState,
} from "@/app/components/canvas/CanvasSaveStatus";
import { InfraAnalysisProvider } from "@/app/components/canvas/InfraAnalysisContext";
import { CanvasNodeMenu } from "@/app/components/canvas/CanvasNodeMenu";
import {
  CanvasRefusal,
  type CanvasRefusalHandle,
} from "@/app/components/canvas/CanvasRefusal";
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { OnboardingDialog } from "@/app/components/OnboardingDialog";
import { StatusDot } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/app/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { CanvasDropPreview } from "@/app/components/canvas/CanvasDropPreview";
import {
  applyCanvasDrop,
  canvasDropTarget,
  pendingDropOf,
  sameCanvasDrop,
  type CanvasDrop,
} from "@/app/lib/canvasDropTarget";
import {
  frameGroupActions,
  nodeLinkActions,
  reconcileFramePositions,
} from "@/app/lib/canvasFrameEdits";
import {
  applyFramedNodeChanges,
  buildFramedGraph,
  serversByNode,
  type StageMcpServer,
} from "@/app/lib/canvasFrameNodes";
import { connectionEdge } from "@/app/components/canvas/edgeOwnership";
import {
  connectionRefusal,
  type ConnectionGraph,
} from "@/app/lib/canvasConnections";
import { analyzeCanvasInfra } from "@/app/lib/canvasRuntimeRefs";
import type { MachineConnection } from "@/app/lib/machineConnection";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  agreedSandboxOrderNumbers,
  workspaceOnlySandboxIds,
} from "@broods/convex/model/canvasFrames";
import { applyTidyLayout, GRID } from "@broods/convex/model/canvasLayout";
import {
  Background,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ObservabilityToolbar } from "../(main)/[projectId]/dashboard/components/ObservabilityToolbar";
import { ObservabilityPageStandIn } from "./ObservabilityPageStandIn";

const LEVEL_OPTIONS = [
  { value: "all", label: "All levels" },
  { value: "ERROR", label: "ERROR" },
  { value: "WARN", label: "WARN" },
  { value: "INFO", label: "INFO" },
  { value: "DEBUG", label: "DEBUG" },
];

const SAVE_STATES: CanvasSaveState[] = ["idle", "saving", "saved", "error"];

/** No frame starts collapsed in the connection fixture. */
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set();

// Enough rows for the stand-in table to scroll, so its head really sticks.
const STAND_IN_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Side-panel tab labels, the row a press most often wanders off. */
const PRESS_TABS = ["Details", "Config", "Settings"];

/**
 * Six cards in two rows, the shape a small stage lands in after a tidy. Sized
 * explicitly so the bounds the canvas fits are the same on every machine, and
 * chosen so the fit zoom lands between ReactFlow's 0.5 floor and our 1.5 cap.
 */
const FIT_NODES: Node[] = [0, 250, 500].flatMap((x) =>
  [0, 260].map((y) => ({
    id: `fit-${x}-${y}`,
    position: { x: x, y: y },
    width: 150,
    height: 40,
    data: { label: `${x},${y}` },
  })),
);

/**
 * Tracy's stage as the frames canvas draws it: a cloud sandbox alone as a
 * card and two computers framed, one connected and one offline; a mounted and
 * an inherited workspace framed, and two read-only ones shared with a coder
 * sub-agent; MCP servers on each transport, the url ones disabled;
 * a code-managed sub-agent link and a user-owned one after it. Laid out by
 * the same tidy layout the canvas button runs, so everything lands where a
 * real stage puts it.
 */
const FRAME_MCP_SERVERS: StageMcpServer[] = [
  fixtureServer("github", "http", null, true),
  fixtureServer("linear", "http", null, true),
  fixtureServer("search", "hosted", null, false),
  fixtureServer("blender", "machine", "kien-mac", false),
];

const FRAME_EDGES: Edge[] = [
  ...[
    "internal-sandbox",
    "kien-mac",
    "phicks-mac",
    "notes",
    "repos",
    "handbook",
    "playbook",
    "github",
    "linear",
    "search",
    "blender",
  ].map((target) => fixtureEdge("tracy", target)),
  fixtureEdge("coder", "handbook"),
  fixtureEdge("coder", "playbook"),
  {
    id: "mount:internal-sandbox-right-notes-left",
    source: "internal-sandbox",
    sourceHandle: "right",
    target: "notes",
    targetHandle: "left",
    type: "mount",
  },
  // Code-managed: the canvas marks it undeletable when it loads it.
  {
    deletable: false,
    id: "subagent:tracy-right-coder-left",
    reconnectable: false,
    source: "tracy",
    sourceHandle: "right",
    target: "coder",
    targetHandle: "left",
    type: "subagent",
  },
  {
    id: "subagent:coder-right-reviewer-left",
    source: "coder",
    sourceHandle: "right",
    target: "reviewer",
    targetHandle: "left",
    type: "subagent",
  },
];

const FRAME_NODES: Node[] = applyTidyLayout(
  [
    fixtureNode("tracy", "agent", {
      sandboxOrder: ["internal-sandbox", "kien-mac", "phicks-mac"],
    }),
    fixtureNode("coder", "agent"),
    fixtureNode("reviewer", "agent"),
    fixtureNode("internal-sandbox", "sandbox", {
      config: { provider: "sandbox" },
    }),
    fixtureNode("kien-mac", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("phicks-mac", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("notes", "workspace"),
    fixtureNode("repos", "workspace"),
    fixtureNode("handbook", "workspace", { readOnly: true }),
    fixtureNode("playbook", "workspace", { readOnly: true }),
    fixtureNode("github", "mcp"),
    fixtureNode("linear", "mcp"),
    fixtureNode("search", "mcp"),
    fixtureNode("blender", "mcp"),
  ],
  FRAME_EDGES,
  serversByNode(FRAME_MCP_SERVERS),
);

const FRAME_ANALYSIS = analyzeCanvasInfra(FRAME_NODES, FRAME_EDGES);

/**
 * The connection fixture: `alpha` owns a two-chip computer frame, `beta` owns
 * nothing in it, and `fresh-box` is a sandbox nobody wired yet. Between them
 * they cover the two drags that were reported broken, an agent onto a brand
 * new card and a second agent onto a chip inside someone else's frame.
 */
const CONNECT_EDGES: Edge[] = [
  fixtureEdge("alpha", "box-one"),
  fixtureEdge("alpha", "box-two"),
];

const CONNECT_NODES: Node[] = applyTidyLayout(
  [
    fixtureNode("alpha", "agent", { sandboxOrder: ["box-one", "box-two"] }),
    fixtureNode("beta", "agent"),
    fixtureNode("box-one", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("box-two", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("fresh-box", "sandbox", { config: { provider: "sandbox" } }),
  ],
  CONNECT_EDGES,
  serversByNode([]),
);

const CONNECT_ANALYSIS = analyzeCanvasInfra(CONNECT_NODES, CONNECT_EDGES);

/**
 * The drag-to-group fixture: `tracy` owns a two-chip cloud frame, `notes` is a
 * workspace of its own, `other` owns the single sandbox `solo`, and `spare` is a
 * cloud sandbox nobody wired. Dragging `spare` onto the frame joins it at the
 * slot it is dropped on, and onto `solo` forms a new group from the two cards.
 * Dragging `notes` onto the frame is refused: no group holds both kinds.
 */
const DROP_EDGES: Edge[] = [
  fixtureEdge("tracy", "box-one"),
  fixtureEdge("tracy", "box-two"),
  fixtureEdge("tracy", "notes"),
  fixtureEdge("other", "solo"),
];

const DROP_NODES: Node[] = applyTidyLayout(
  [
    fixtureNode("tracy", "agent", { sandboxOrder: ["box-one", "box-two"] }),
    fixtureNode("box-one", "sandbox"),
    fixtureNode("box-two", "sandbox"),
    fixtureNode("notes", "workspace"),
    fixtureNode("other", "agent"),
    fixtureNode("solo", "sandbox"),
    fixtureNode("spare", "sandbox"),
  ],
  DROP_EDGES,
  serversByNode([]),
);

/** The url MCP frame starts collapsed, so the fixture shows both frame states. */
const COLLAPSED_FIXTURE_FRAME = "frame:tracy:mcp:http";

const subscribeNever = (): (() => void) => () => {};

export function UiGallery(): React.JSX.Element {
  const [level, setLevel] = useState("INFO");
  const [search, setSearch] = useState("");
  const [pressLevel, setPressLevel] = useState("INFO");
  const [pressTab, setPressTab] = useState(PRESS_TABS[0]);
  const [pressCount, setPressCount] = useState(0);
  const [saveState, setSaveState] = useState<CanvasSaveState>("idle");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // False in the server HTML, true once React owns the page: a spec waits on
  // it so its first interaction lands on a listener, not on static markup.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const dashboardTab = useSearchParams().get("tab");

  // A trace link keeps the path and swaps ?tab=, so the dashboard stand-in
  // answers the same parameter the dashboard page does.
  if (dashboardTab === "monitoring" || dashboardTab === "tracing") {
    return <ObservabilityPageStandIn tab={dashboardTab} />;
  }

  return (
    <main
      className="flex flex-col gap-10 p-8"
      data-hydrated={hydrated ? "true" : undefined}
    >
      <section
        data-fixture="observability-toolbar"
        className="flex flex-col gap-2"
      >
        <h2 className="text-sm font-medium">Observability toolbar</h2>
        <ObservabilityToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search logs…"
          filterAriaLabel="Filter by log level"
          filterValue={level}
          filterOptions={LEVEL_OPTIONS}
          onFilterChange={setLevel}
          fromTime=""
          onFromTimeChange={() => {}}
          toTime=""
          onToTimeChange={() => {}}
          hasFilters={false}
          onClear={() => {}}
          onRefresh={() => {}}
          refreshDisabled={false}
          refreshSpinning={false}
          refreshTitle="Refresh"
          isError={false}
        />
        <LogTableStandIn />
      </section>

      <section data-fixture="canvas-controls" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas controls</h2>
        <div className="relative h-40 w-80 rounded-lg border border-border">
          <ReactFlowProvider>
            <div className="absolute top-2 left-2">
              <CanvasControls onTidy={() => {}} />
            </div>
          </ReactFlowProvider>
          <div className="absolute bottom-2 left-2">
            <CanvasSaveStatus state={saveState} onRetry={() => {}} />
          </div>
        </div>
        <div className="flex gap-2">
          {SAVE_STATES.map((state) => (
            <Button
              key={state}
              size="sm"
              variant="outline"
              className="cursor-pointer"
              data-save-state={state}
              onClick={() => setSaveState(state)}
            >
              {state}
            </Button>
          ))}
        </div>
      </section>

      <section data-fixture="canvas-fit" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas fit on open</h2>
        {/* The real ReactFlow, fitted the way the Architecture page fits on its
            first paint, so a spec can measure what the frame actually shows. */}
        <div className="h-80 w-[36rem] rounded-lg border border-border">
          <ReactFlow
            nodes={FIT_NODES}
            edges={[]}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={FIT_VIEW_OPTIONS.maxZoom}
          />
        </div>
      </section>

      <section data-fixture="canvas-frames" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas frames</h2>
        <CanvasFramesFixture />
      </section>

      <section data-fixture="canvas-connect" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas connections</h2>
        <CanvasConnectFixture />
      </section>

      <section data-fixture="canvas-drop" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas drag into a group</h2>
        <CanvasDropFixture />
      </section>

      <section data-fixture="canvas-node-menu" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas card menu</h2>
        {/* The frames stage above, read by the real menu builders: coder has a
            code-managed link, handbook sits in a group. */}
        <div className="flex gap-2">
          <CanvasNodeMenuFixture nodeId="coder" />
          <CanvasNodeMenuFixture nodeId="handbook" />
        </div>
      </section>

      <section data-fixture="press-drag" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Press that wanders</h2>
        {/* One of each control a press lands on, with the state it changes
            rendered next to it, so a spec can press with a few pixels of
            travel and assert the press still counted. */}
        <nav
          aria-label="Press row"
          className="flex flex-wrap items-center gap-3"
        >
          <Button size="sm" onClick={() => setPressCount(pressCount + 1)}>
            Deploy the stage
          </Button>
          <Tabs value={pressTab} onValueChange={setPressTab}>
            <TabsList variant="line">
              {PRESS_TABS.map((tab) => (
                <TabsTrigger key={tab} value={tab}>
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Select
            items={LEVEL_OPTIONS}
            value={pressLevel}
            onValueChange={(value) => {
              if (value !== null) {
                setPressLevel(value);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Press filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Link
            href="/ui-gallery"
            draggable={false}
            className="cursor-pointer select-none rounded-md px-2.5 py-1.5 text-sm font-medium hover:bg-accent"
          >
            Architecture
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground">
          pressed <span data-press-count>{pressCount}</span>, tab{" "}
          <span data-press-tab>{pressTab}</span>, level{" "}
          <span data-press-level>{pressLevel}</span>
        </p>
      </section>

      <section data-fixture="detail-split" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Detail split</h2>
        {/* The split every observability table sits in, at a fixed frame so a
            spec can measure the panel's width and where the handle drags to. */}
        <Button
          size="sm"
          variant="outline"
          className="w-fit cursor-pointer"
          onClick={() => setDetailOpen(true)}
        >
          Open details
        </Button>
        <div className="flex h-64 w-[64rem]">
          <DetailSplit
            detail={
              detailOpen && (
                <DetailPanel
                  title="stand-in row 3"
                  meta={
                    <div className="mt-0.5 text-2xs text-muted-foreground">
                      INFO · gateway
                    </div>
                  }
                  onClose={() => setDetailOpen(false)}
                >
                  <p className="text-xs">Detail body</p>
                </DetailPanel>
              )
            }
          >
            <StandInTable />
          </DetailSplit>
        </div>
      </section>

      <section data-fixture="onboarding" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Onboarding</h2>
        <Button
          size="sm"
          variant="outline"
          className="w-fit cursor-pointer"
          onClick={() => setOnboardingOpen(true)}
        >
          Open onboarding
        </Button>
        {onboardingOpen && (
          <OnboardingDialog
            secret="fixture-account-secret-not-a-real-credential"
            onDone={() => setOnboardingOpen(false)}
          />
        )}
      </section>
    </main>
  );
}

/**
 * The real node and edge components on a static graph. Stage data comes from
 * the frames context instead of Convex, one machine connected and one offline.
 */
/**
 * A connectable canvas: the same nodes, handles and validator the real one
 * uses, so a spec can drag an edge and find out whether it lands. Every edge
 * it accepts is listed under the canvas, since a refused drop leaves nothing
 * on screen to assert.
 */
function CanvasConnectFixture(): React.JSX.Element {
  const [edges, setEdges] = useState<Edge[]>(CONNECT_EDGES);
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const graph = useMemo(
    () =>
      buildFramedGraph(
        CONNECT_NODES,
        edges,
        [],
        EMPTY_COLLAPSED,
        expandedMemberId,
        null,
      ),
    [edges, expandedMemberId],
  );
  const frames = useMemo(
    (): CanvasFramesValue => ({
      expandedMemberId: expandedMemberId,
      machineConnections: [],
      mcpServers: serversByNode([]),
      onToggleFrame: () => undefined,
      sandboxOrderNumbers: agreedSandboxOrderNumbers(CONNECT_NODES, edges),
      workspaceOnlySandboxIds: workspaceOnlySandboxIds(CONNECT_NODES, edges),
    }),
    [edges, expandedMemberId],
  );
  const getGraph = useCallback(
    (): ConnectionGraph => ({ edges: edges, nodes: CONNECT_NODES }),
    [edges],
  );
  const refusalRef = useRef<CanvasRefusalHandle>(null);

  return (
    <InfraAnalysisProvider value={CONNECT_ANALYSIS}>
      <CanvasFramesProvider value={frames}>
        <div className="h-96 w-full max-w-[52rem] rounded-lg border border-border">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={CANVAS_NODE_TYPES}
            edgeTypes={CANVAS_EDGE_TYPES}
            colorMode="dark"
            connectionMode={ConnectionMode.Loose}
            connectionRadius={CONNECTION_RADIUS}
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={FIT_VIEW_OPTIONS.maxZoom}
            nodesDraggable={false}
            // Fit once the nodes are measured. Fitting on mount reads them as
            // zero-sized here and parks the graph outside the box.
            onInit={(instance) => {
              void instance.fitView(FIT_VIEW_OPTIONS);
            }}
            isValidConnection={(connection) =>
              connectionRefusal(getGraph(), connection) === null
            }
            onConnectStart={() => refusalRef.current?.clear()}
            onConnectEnd={(event, connection) =>
              refusalRef.current?.onConnectEnd(event, connection)
            }
            onConnect={(connection) =>
              setEdges((current) => [
                ...current,
                connectionEdge(
                  connection,
                  CONNECT_NODES.find((node) => node.id === connection.source)
                    ?.type === "agent",
                ),
              ])
            }
            onNodeClick={(_event, node) =>
              setExpandedMemberId(node.type === "frame" ? null : node.id)
            }
            onPaneClick={() => setExpandedMemberId(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              bgColor="#000"
              color="rgba(255,255,255,0.3)"
              gap={GRID}
              size={2}
            />
            <CanvasRefusal ref={refusalRef} getGraph={getGraph} />
          </ReactFlow>
        </div>
        <output
          data-testid="connect-log"
          className="text-2xs text-muted-foreground"
        >
          {edges.map((edge) => edge.id).join(" | ")}
        </output>
      </CanvasFramesProvider>
    </InfraAnalysisProvider>
  );
}

/** A right-click target that opens the card menu the canvas would, for one fixture node. */
function CanvasNodeMenuFixture({
  nodeId,
}: {
  nodeId: string;
}): React.JSX.Element {
  const [last, setLast] = useState("none");

  return (
    <ContextMenu>
      <ContextMenuTrigger
        data-testid={`menu-target-${nodeId}`}
        className="flex h-16 w-44 cursor-context-menu flex-col justify-center rounded-md border border-border px-3 text-xs"
      >
        {nodeId}
        <output className="text-2xs text-muted-foreground">{last}</output>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <CanvasNodeMenu
          nodeId={nodeId}
          links={nodeLinkActions(FRAME_NODES, FRAME_EDGES, nodeId)}
          groups={frameGroupActions(
            {
              edges: FRAME_EDGES,
              mcpServers: FRAME_MCP_SERVERS,
              nodes: FRAME_NODES,
            },
            nodeId,
          )}
          deleteLocked={nodeId === "coder"}
          onOpen={() => setLast("open")}
          onDelete={() => setLast("delete")}
          onMakeDefault={() => setLast("make-default")}
          onRemoveEdge={(edgeId) => setLast(`unlink ${edgeId}`)}
          onSetUngrouped={(nodeIds) => setLast(`group ${nodeIds.join(",")}`)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The real drop rules under a real drag: `canvasDropTarget` while the card moves,
 * `applyCanvasDrop` when it lands, and the frame growing a slot in between. The
 * log names the group it joined and the slot it took, so a spec can read both.
 */
function CanvasDropFixture(): React.JSX.Element {
  const [nodes, setNodes] = useState<Node[]>(DROP_NODES);
  const [edges, setEdges] = useState<Edge[]>(DROP_EDGES);
  const [drop, setDrop] = useState<CanvasDrop | null>(null);
  const [last, setLast] = useState("");
  // Read on release, when the state the preview renders from is a render behind.
  const dropRef = useRef<CanvasDrop | null>(null);
  const graph = useMemo(
    () =>
      buildFramedGraph(
        nodes,
        edges,
        [],
        EMPTY_COLLAPSED,
        null,
        null,
        pendingDropOf(drop),
      ),
    [drop, edges, nodes],
  );
  const frames = useMemo(
    (): CanvasFramesValue => ({
      expandedMemberId: null,
      machineConnections: [],
      mcpServers: serversByNode([]),
      onToggleFrame: () => undefined,
      sandboxOrderNumbers: agreedSandboxOrderNumbers(nodes, edges),
      workspaceOnlySandboxIds: workspaceOnlySandboxIds(nodes, edges),
    }),
    [edges, nodes],
  );
  const analysis = useMemo(
    () => analyzeCanvasInfra(nodes, edges),
    [edges, nodes],
  );

  return (
    <InfraAnalysisProvider value={analysis}>
      <CanvasFramesProvider value={frames}>
        <div className="h-96 w-full max-w-[52rem] rounded-lg border border-border">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={CANVAS_NODE_TYPES}
            edgeTypes={CANVAS_EDGE_TYPES}
            colorMode="dark"
            connectionMode={ConnectionMode.Loose}
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={FIT_VIEW_OPTIONS.maxZoom}
            // Fit once the nodes are measured, as the connect fixture does.
            onInit={(instance) => {
              void instance.fitView(FIT_VIEW_OPTIONS);
            }}
            onNodesChange={(changes) =>
              setNodes((current) =>
                applyFramedNodeChanges(
                  changes,
                  current,
                  edges,
                  [],
                  EMPTY_COLLAPSED,
                ),
              )
            }
            onNodeDrag={(_event, grabbed, dragged) => {
              const next =
                dragged.length === 1 && grabbed.type !== "frame"
                  ? canvasDropTarget({
                      collapsedFrames: EMPTY_COLLAPSED,
                      expandedMemberId: null,
                      graph: { edges: edges, mcpServers: [], nodes: nodes },
                      nodeId: grabbed.id,
                      position: grabbed.position,
                    })
                  : null;
              if (sameCanvasDrop(dropRef.current, next)) return;
              dropRef.current = next;
              setDrop(next);
            }}
            onNodeDragStop={(_event, grabbed) => {
              const pending = dropRef.current;
              dropRef.current = null;
              setDrop(null);
              if (pending?.refusal !== null || pending.nodeId !== grabbed.id) {
                return;
              }
              const before = { edges: edges, mcpServers: [], nodes: nodes };
              const after = applyCanvasDrop(before, pending);
              setEdges(after.edges);
              setNodes(
                reconcileFramePositions(before, {
                  edges: after.edges,
                  mcpServers: [],
                  nodes: after.nodes,
                }),
              );
              setLast(`joined ${pending.label} at ${pending.slot}`);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              bgColor="#000"
              color="rgba(255,255,255,0.3)"
              gap={GRID}
              size={2}
            />
            <CanvasDropPreview drop={drop} />
          </ReactFlow>
        </div>
        <output
          data-testid="drop-log"
          className="text-2xs text-muted-foreground"
        >
          {last}
        </output>
      </CanvasFramesProvider>
    </InfraAnalysisProvider>
  );
}

function CanvasFramesFixture(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set([COLLAPSED_FIXTURE_FRAME]),
  );
  // The canvas reads this off its selection; the fixture has no side panel, so
  // it keeps the clicked chip itself.
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const graph = useMemo(
    () =>
      buildFramedGraph(
        FRAME_NODES,
        FRAME_EDGES,
        FRAME_MCP_SERVERS,
        collapsed,
        expandedMemberId,
        null,
      ),
    [collapsed, expandedMemberId],
  );
  const frames = useMemo(
    (): CanvasFramesValue => ({
      expandedMemberId: expandedMemberId,
      machineConnections: [
        fixtureConnection("kien-mac", Date.now(), undefined),
        fixtureConnection("phicks-mac", Date.now() - 3_600_000, Date.now()),
      ],
      mcpServers: serversByNode(FRAME_MCP_SERVERS),
      onToggleFrame: (frameId) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(frameId)) next.add(frameId);

          return next;
        }),
      sandboxOrderNumbers: agreedSandboxOrderNumbers(FRAME_NODES, FRAME_EDGES),
      workspaceOnlySandboxIds: workspaceOnlySandboxIds(
        FRAME_NODES,
        FRAME_EDGES,
      ),
    }),
    [expandedMemberId],
  );

  return (
    <InfraAnalysisProvider value={FRAME_ANALYSIS}>
      <CanvasFramesProvider value={frames}>
        <div className="h-[30rem] w-[80rem] rounded-lg border border-border">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={CANVAS_NODE_TYPES}
            edgeTypes={CANVAS_EDGE_TYPES}
            colorMode="dark"
            // Mount and runs-on edges end on source-type side handles, as on the canvas.
            connectionMode={ConnectionMode.Loose}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={FIT_VIEW_OPTIONS.maxZoom}
            nodesDraggable={false}
            onNodeClick={(_event, node) =>
              setExpandedMemberId(node.type === "frame" ? null : node.id)
            }
            onPaneClick={() => setExpandedMemberId(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              bgColor="#000"
              color="rgba(255,255,255,0.3)"
              gap={GRID}
              size={2}
            />
          </ReactFlow>
        </div>
      </CanvasFramesProvider>
    </InfraAnalysisProvider>
  );
}

/** A machine daemon's connection row; offline when `disconnectedAt` is set. */
function fixtureConnection(
  name: string,
  lastSeenAt: number,
  disconnectedAt: number | undefined,
): MachineConnection {
  return {
    _creationTime: lastSeenAt,
    _id: `connection-${name}` as Id<"machineConnections">,
    accountId: "fixture-account" as Id<"accounts">,
    computer: false,
    connectedAt: lastSeenAt,
    connectionId: `connection-${name}`,
    disconnectedAt: disconnectedAt,
    lastSeenAt: lastSeenAt,
    mcp: [],
    name: name,
    sandboxConfigId: `sandbox-${name}` as Id<"sandboxConfigs">,
  };
}

function fixtureEdge(source: string, target: string): Edge {
  return { id: `xy-edge__${source}-${target}`, source: source, target: target };
}

function fixtureNode(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): Node {
  return {
    data: { label: id, status: "idle", ...data },
    id: id,
    position: { x: 0, y: 0 },
    type: type,
  };
}

function fixtureServer(
  nodeId: string,
  transport: StageMcpServer["transport"],
  sandbox: string | null,
  disabled: boolean,
): StageMcpServer {
  return {
    disabled: disabled,
    name: nodeId,
    nodeId: nodeId,
    sandbox: sandbox,
    transport: transport,
  };
}

/**
 * The piece of MonitoringPanel that broke the level select: a sticky, raised
 * table head right under the toolbar. Without page chrome like this below it,
 * a popup that fails to stack above the page still looks perfectly fine.
 */
function LogTableStandIn(): React.JSX.Element {
  return (
    <div className="flex h-50 overflow-hidden rounded-lg border border-border bg-card">
      <div className="min-w-0 flex-1 overflow-auto">
        <StandInTable />
      </div>
    </div>
  );
}

/** The log table's shape, sticky head included, for any fixture that needs rows. */
function StandInTable(): React.JSX.Element {
  return (
    <table className="w-full table-fixed font-mono text-xs">
      <thead className="sticky top-0 z-10 border-b border-border bg-card/95">
        <tr className="text-left text-2xs uppercase tracking-wide text-muted-foreground">
          <th className="px-3 py-2 font-medium">Time</th>
          <th className="px-3 py-2 font-medium">Level</th>
          <th className="px-3 py-2 font-medium">Service</th>
          <th className="px-3 py-2 font-medium">Message</th>
        </tr>
      </thead>
      <tbody>
        {STAND_IN_ROWS.map((row) => (
          <tr key={row} className="border-b border-border/40">
            <td className="px-3 py-1.5 text-muted-foreground">08:0{row}</td>
            <td className="px-3 py-1.5">
              <StatusDot tone="ok" />
            </td>
            <td className="px-3 py-1.5">gateway</td>
            <td className="px-3 py-1.5">stand-in row {row}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
