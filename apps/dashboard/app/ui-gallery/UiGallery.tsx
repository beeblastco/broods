"use client";

import { RuntimeKeyView } from "@/app/(main)/[projectId]/dashboard/components/RuntimeKeyDialog";
import {
  ConnectionsView,
  type Connection,
} from "@/app/(main)/settings/connections/components/ConnectionsPanel";
import {
  CANVAS_EDGE_TYPES,
  CANVAS_NODE_TYPES,
  CONNECTION_RADIUS,
} from "@/app/components/canvas/Canvas";
import {
  CanvasControls,
  FIT_VIEW_OPTIONS,
} from "@/app/components/canvas/CanvasControl";
import { CanvasDropPreview } from "@/app/components/canvas/CanvasDropPreview";
import { CanvasNoticeStrip } from "@/app/components/canvas/CanvasNotice";
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
import { SpecsValue } from "@/app/(main)/[projectId]/sandbox/components/sandboxFormat";
import { StatusDot } from "@/app/components/StatusDot";
import { StatusPage } from "@/app/components/StatusPage";
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
import { useHydrated } from "@/app/hooks/useHydrated";
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
  setWorkspaceMount,
  workspaceMountTargets,
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
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
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
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ObservabilityToolbar,
  type VolumePoint,
} from "../(main)/[projectId]/dashboard/components/ObservabilityToolbar";
import type { RangePreset, TimeWindow } from "@/app/lib/queryTokens";
import { ObservabilityPageStandIn } from "./ObservabilityPageStandIn";
import { SandboxInstancesStandIn } from "./SandboxInstancesStandIn";
import { DataTableStandIn } from "./DataTableStandIn";
import { MotionStandIn } from "./MotionStandIn";
import { ShortcutsStandIn } from "./ShortcutsStandIn";
import { InlineEditStandIn } from "./InlineEditStandIn";
import { UsageChartStandIn } from "./UsageChartStandIn";
import { AllowanceStandIn } from "./AllowanceStandIn";
import { WorkspaceFilesStandIn } from "./WorkspaceFilesStandIn";

const LEVEL_OPTIONS = [
  { value: "all", label: "All levels" },
  { value: "ERROR", label: "ERROR" },
  { value: "WARN", label: "WARN" },
  { value: "INFO", label: "INFO" },
  { value: "DEBUG", label: "DEBUG" },
];

const LOG_FIELDS = ["level", "source", "agent", "trace", "event"] as const;

const FIXTURE_NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

const VOLUME_POINTS: VolumePoint[] = Array.from({ length: 40 }, (_, i) => ({
  ts: FIXTURE_NOW - 60 * 60 * 1000 + i * 90 * 1000,
  severity: i === 36 ? "error" : i % 7 === 0 ? "warn" : "none",
}));

const SAVE_STATES: CanvasSaveState[] = ["idle", "saving", "saved", "error"];

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set();

// Enough rows to scroll, or the sticky head is never tested.
const STAND_IN_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const PRESS_TABS = ["Details", "Config", "Settings"];

// Sized so the fit zoom lands between ReactFlow's 0.5 floor and our 1.5 cap on every machine.
const FIT_NODES: Node[] = [0, 250, 500].flatMap((x) =>
  [0, 260].map((y) => ({
    id: `fit-${x}-${y}`,
    position: { x: x, y: y },
    width: 150,
    height: 40,
    data: { label: `${x},${y}` },
  })),
);

const FRAME_MCP_SERVERS: StageMcpServer[] = [
  fixtureServer("github", "http", null, true),
  fixtureServer("linear", "http", null, true),
  fixtureServer("search", "hosted", null, false),
  fixtureServer("blender", "machine", "laptop-mac", false),
];

const FRAME_EDGES: Edge[] = [
  ...[
    "internal-sandbox",
    "laptop-mac",
    "office-mac",
    "notes",
    "repos",
    "handbook",
    "playbook",
    "github",
    "linear",
    "search",
    "blender",
  ].map((target) => fixtureEdge("support", target)),
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
  {
    deletable: false,
    id: "subagent:support-right-coder-left",
    reconnectable: false,
    source: "support",
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
    fixtureNode("support", "agent", {
      sandboxOrder: ["internal-sandbox", "laptop-mac", "office-mac"],
    }),
    fixtureNode("coder", "agent"),
    fixtureNode("reviewer", "agent"),
    fixtureNode("internal-sandbox", "sandbox", {
      config: { provider: "sandbox" },
    }),
    fixtureNode("laptop-mac", "sandbox", { config: { provider: "machine" } }),
    fixtureNode("office-mac", "sandbox", { config: { provider: "machine" } }),
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

const DROP_EDGES: Edge[] = [
  fixtureEdge("support", "box-one"),
  fixtureEdge("support", "box-two"),
  fixtureEdge("support", "notes"),
  fixtureEdge("other", "solo"),
];

const DROP_NODES: Node[] = applyTidyLayout(
  [
    fixtureNode("support", "agent", { sandboxOrder: ["box-one", "box-two"] }),
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

const COLLAPSED_FIXTURE_FRAME = "frame:support:mcp:http";

const CONVEX_SERVER_ERROR = new Error(
  "[CONVEX A(org/lifecycle:provision)] [Request ID: 4f1c9a2e7b3d0a51] Server Error\n  Called by client",
);

const SIZE_ROWS: Array<{
  provider: string;
  specs: Doc<"sandboxInstances">["specs"] | undefined;
  verified: boolean;
}> = [
  {
    provider: "daytona",
    specs: { vcpu: 2, memoryMb: 4096, storageGb: 10 },
    verified: true,
  },
  { provider: "e2b", specs: { vcpu: 2, memoryMb: 512 }, verified: true },
  {
    provider: "lambda",
    specs: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
    verified: false,
  },
  { provider: "machine", specs: undefined, verified: true },
];

const CONNECTION_FIXTURES: Connection[] = [
  {
    type: "chatgpt",
    clientId: "oaiapp_fixture",
    hostId: "urn:uuid:fixture",
    email: "owner@example.com",
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    expiresAt: 0,
    updatedAt: 0,
  },
];

export function UiGallery(): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [range, setRange] = useState<RangePreset>("1h");
  const [timeWindow, setTimeWindow] = useState<TimeWindow | null>(null);
  const [pressLevel, setPressLevel] = useState("INFO");
  const [pressTab, setPressTab] = useState(PRESS_TABS[0]);
  const [pressCount, setPressCount] = useState(0);
  const [saveState, setSaveState] = useState<CanvasSaveState>("idle");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const hydrated = useHydrated();
  const dashboardTab = useSearchParams().get("tab");

  if (dashboardTab === "connections") {
    return (
      <main
        data-hydrated={hydrated ? "true" : undefined}
        className="mx-auto grid w-full max-w-2xl gap-10 px-6 pt-6 pb-12"
      >
        <ConnectionsView
          connections={CONNECTION_FIXTURES}
          canWrite={true}
          onDisconnect={() => {}}
        />
        <ConnectionsView
          connections={[]}
          canWrite={true}
          onDisconnect={() => {}}
        />
      </main>
    );
  }

  if (dashboardTab === "credential-copy") {
    return (
      <main data-hydrated={hydrated ? "true" : undefined}>
        <RuntimeKeyView apiKey="clipboard fixture" />
      </main>
    );
  }

  if (dashboardTab === "workspace-files") {
    return (
      <main
        className="flex gap-10 p-8"
        data-hydrated={hydrated ? "true" : undefined}
      >
        <section data-fixture="files-writer">
          <WorkspaceFilesStandIn canWrite={true} />
        </section>
        <section data-fixture="files-member">
          <WorkspaceFilesStandIn canWrite={false} />
        </section>
      </main>
    );
  }

  if (dashboardTab === "sandbox") {
    return <SandboxInstancesStandIn />;
  }

  if (dashboardTab === "monitoring" || dashboardTab === "tracing") {
    return <ObservabilityPageStandIn tab={dashboardTab} />;
  }

  if (dashboardTab === "shortcuts") {
    return <ShortcutsStandIn />;
  }

  if (dashboardTab === "inline-edit") {
    return <InlineEditStandIn />;
  }

  if (dashboardTab === "motion") {
    return <MotionStandIn />;
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
          searchPlaceholder="Search logs · level: source: agent: trace: event:"
          searchFields={LOG_FIELDS}
          range={range}
          onRangeChange={setRange}
          window={timeWindow}
          onWindowChange={setTimeWindow}
          points={VOLUME_POINTS}
          now={FIXTURE_NOW}
          onRefresh={() => {}}
          refreshDisabled={false}
          refreshTitle="Refresh"
          isError={false}
        />
        <p className="text-xs text-muted-foreground">
          query <span data-toolbar-query>{search}</span>
          {timeWindow && (
            <>
              {" · window "}
              <span data-toolbar-window>
                {Math.round(timeWindow.from)}-{Math.round(timeWindow.to)}
              </span>
            </>
          )}
        </p>
        <LogTableStandIn />
      </section>

      <section data-fixture="data-table" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Data table</h2>
        <DataTableStandIn />
      </section>

      <section data-fixture="usage-chart" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Usage chart</h2>
        <UsageChartStandIn />
      </section>

      <section data-fixture="allowance" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Resources, one project</h2>
        <AllowanceStandIn
          view={{ scope: "project", projectId: "support-bot" }}
        />
      </section>

      <section data-fixture="allowance-org" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Resources, the organization</h2>
        <AllowanceStandIn view={{ scope: "all" }} />
      </section>

      <section data-fixture="canvas-controls" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Canvas controls</h2>
        {/* Wide enough that a centred notice clears the controls, as on the canvas. */}
        <div className="relative h-40 w-full max-w-md rounded-lg border border-border">
          <ReactFlowProvider>
            <div className="absolute top-2 left-2">
              <CanvasControls onTidy={() => {}} />
            </div>
          </ReactFlowProvider>
          <div className="pointer-events-none absolute top-2 right-0 left-0 flex justify-center">
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
        <div className="flex gap-2">
          <CanvasNodeMenuFixture nodeId="coder" />
          <CanvasNodeMenuFixture nodeId="handbook" />
        </div>
      </section>

      <section data-fixture="press-drag" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Press that wanders</h2>
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

      <section data-fixture="status-page" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Status page under the header</h2>
        <div className="flex h-64 w-160 flex-col border border-border">
          <div className="h-10 shrink-0 border-b border-border" />
          <div data-status-frame className="min-h-0 flex-1">
            <StatusPage
              title="Workspace setup failed"
              error={CONVEX_SERVER_ERROR}
            >
              <Button className="cursor-pointer">Retry</Button>
            </StatusPage>
          </div>
        </div>
      </section>

      <section data-fixture="sandbox-size" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Sandbox size</h2>
        <table className="w-fit text-xs whitespace-nowrap">
          <tbody>
            {SIZE_ROWS.map((row) => (
              <tr
                key={row.provider}
                data-provider={row.provider}
                className="border-t border-border"
              >
                <td className="px-4 py-2.5">{row.provider}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  <SpecsValue
                    specs={row.specs}
                    verified={row.verified}
                    provider={row.provider}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
      agentBadges: {},
      canWrite: true,
      expandedMemberId: expandedMemberId,
      machineConnections: [],
      mcpServers: serversByNode([]),
      mountTargetsOf: (workspaceId) =>
        workspaceMountTargets(CONNECT_NODES, edges, workspaceId),
      onSetWorkspaceMount: (workspaceId, target) =>
        setEdges(
          (current) =>
            setWorkspaceMount(
              { edges: current, mcpServers: [], nodes: CONNECT_NODES },
              workspaceId,
              target,
            ).edges,
        ),
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
            // fitView on mount reads the nodes as zero-sized here; fit once they are measured.
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
            <CanvasNoticeStrip>
              <CanvasRefusal ref={refusalRef} getGraph={getGraph} />
            </CanvasNoticeStrip>
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
          label={nodeId}
          links={nodeLinkActions(FRAME_NODES, FRAME_EDGES, nodeId)}
          groups={frameGroupActions(
            {
              edges: FRAME_EDGES,
              mcpServers: FRAME_MCP_SERVERS,
              nodes: FRAME_NODES,
            },
            nodeId,
          )}
          mounts={workspaceMountTargets(FRAME_NODES, FRAME_EDGES, nodeId)}
          deleteLocked={nodeId === "coder"}
          onOpen={() => setLast("open")}
          onDelete={() => setLast("delete")}
          onMakeDefault={() => setLast("make-default")}
          onRemoveEdge={(edgeId) => setLast(`unlink ${edgeId}`)}
          onRename={(_id, label) => setLast(`rename ${label}`)}
          onSetMount={(_id, target) => setLast(`mount ${target.kind}`)}
          onSetUngrouped={(nodeIds) => setLast(`group ${nodeIds.join(",")}`)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CanvasDropFixture(): React.JSX.Element {
  const [nodes, setNodes] = useState<Node[]>(DROP_NODES);
  const [edges, setEdges] = useState<Edge[]>(DROP_EDGES);
  const [drop, setDrop] = useState<CanvasDrop | null>(null);
  const [last, setLast] = useState("");
  // Read on release, when the `drop` state is still a render behind.
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
      agentBadges: {},
      canWrite: true,
      expandedMemberId: null,
      machineConnections: [],
      mcpServers: serversByNode([]),
      mountTargetsOf: () => [],
      onSetWorkspaceMount: () => undefined,
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
            <CanvasNoticeStrip>
              <CanvasDropPreview drop={drop} />
            </CanvasNoticeStrip>
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
      agentBadges: {},
      canWrite: true,
      expandedMemberId: expandedMemberId,
      machineConnections: [
        fixtureConnection("laptop-mac", Date.now(), undefined),
        fixtureConnection("office-mac", Date.now() - 3_600_000, Date.now()),
      ],
      mcpServers: serversByNode(FRAME_MCP_SERVERS),
      mountTargetsOf: (workspaceId) =>
        workspaceMountTargets(FRAME_NODES, FRAME_EDGES, workspaceId),
      onSetWorkspaceMount: () => undefined,
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

// A raised sticky head under the toolbar: without it, a popup that fails to stack looks fine.
function LogTableStandIn(): React.JSX.Element {
  return (
    <div className="flex h-50 overflow-hidden rounded-lg border border-border bg-card">
      <div className="min-w-0 flex-1 overflow-auto">
        <StandInTable />
      </div>
    </div>
  );
}

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
