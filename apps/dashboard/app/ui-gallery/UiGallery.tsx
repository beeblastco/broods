"use client";

import {
  CANVAS_EDGE_TYPES,
  CANVAS_NODE_TYPES,
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
import { DetailPanel, DetailSplit } from "@/app/components/DetailSplit";
import { OnboardingDialog } from "@/app/components/OnboardingDialog";
import { StatusDot } from "@/app/components/StatusDot";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import {
  buildFramedGraph,
  type StageMcpServer,
} from "@/app/lib/canvasFrameNodes";
import { analyzeCanvasInfra } from "@/app/lib/canvasRuntimeRefs";
import type { MachineConnection } from "@/app/lib/machineConnection";
import type { Id } from "@broods/convex/_generated/dataModel";
import { sandboxOrderNumbers } from "@broods/convex/model/canvasFrames";
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
import { useMemo, useState, useSyncExternalStore } from "react";
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
 * Tracy's stage as the frames canvas draws it: three sandboxes in order, a
 * mounted, an inherited and a read-only workspace, MCP servers on each
 * transport and a session store. Laid out by the same tidy layout the canvas
 * button runs, so the frames land where a real stage puts them.
 */
const FRAME_EDGES: Edge[] = [
  ...[
    "session",
    "internal-sandbox",
    "kien-mac",
    "phicks-mac",
    "notes",
    "repos",
    "handbook",
    "github",
    "linear",
    "search",
    "blender",
  ].map((target) => ({
    id: `xy-edge__tracy-${target}`,
    source: "tracy",
    target: target,
  })),
  {
    id: "mount:internal-sandbox-right-notes-left",
    source: "internal-sandbox",
    sourceHandle: "right",
    target: "notes",
    targetHandle: "left",
    type: "mount",
  },
];

const FRAME_NODES: Node[] = applyTidyLayout(
  [
    fixtureNode("tracy", "agent", {
      sandboxOrder: ["internal-sandbox", "kien-mac", "phicks-mac"],
    }),
    fixtureNode("session", "database"),
    fixtureNode("internal-sandbox", "sandbox", {
      config: { provider: "sandbox" },
    }),
    fixtureNode("kien-mac", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("phicks-mac", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("notes", "workspace"),
    fixtureNode("repos", "workspace"),
    fixtureNode("handbook", "workspace", { readOnly: true }),
    fixtureNode("github", "mcp"),
    fixtureNode("linear", "mcp"),
    fixtureNode("search", "mcp"),
    fixtureNode("blender", "mcp"),
  ],
  FRAME_EDGES,
  new Map([
    ["github", "http"],
    ["linear", "http"],
    ["search", "hosted"],
    ["blender", "machine"],
  ]),
);

const FRAME_ANALYSIS = analyzeCanvasInfra(FRAME_NODES, FRAME_EDGES);

const FRAME_MCP_SERVERS: StageMcpServer[] = [
  fixtureServer("github", "http", null),
  fixtureServer("linear", "http", null),
  fixtureServer("search", "hosted", null),
  fixtureServer("blender", "machine", "kien-mac"),
];

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
function CanvasFramesFixture(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set([COLLAPSED_FIXTURE_FRAME]),
  );
  const graph = useMemo(
    () =>
      buildFramedGraph(FRAME_NODES, FRAME_EDGES, FRAME_MCP_SERVERS, collapsed),
    [collapsed],
  );
  const frames = useMemo(
    (): CanvasFramesValue => ({
      machineConnections: [
        fixtureConnection("kien-mac", Date.now(), undefined),
        fixtureConnection("phicks-mac", Date.now() - 3_600_000, Date.now()),
      ],
      mcpServers: new Map(
        FRAME_MCP_SERVERS.map((server) => [server.nodeId, server]),
      ),
      onToggleFrame: (frameId) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(frameId)) next.add(frameId);

          return next;
        }),
      sandboxOrderNumbers: sandboxOrderNumbers(FRAME_NODES, FRAME_EDGES),
    }),
    [],
  );

  return (
    <InfraAnalysisProvider value={FRAME_ANALYSIS}>
      <CanvasFramesProvider value={frames}>
        <div className="h-[40rem] w-[64rem] rounded-lg border border-border">
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
): StageMcpServer {
  return {
    disabled: false,
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
