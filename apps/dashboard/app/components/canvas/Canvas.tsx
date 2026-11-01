"use client";

import {
  CanvasControls,
  FIT_VIEW_OPTIONS,
} from "@/app/components/canvas/CanvasControl";
import {
  CanvasSaveStatus,
  type CanvasSaveState,
} from "@/app/components/canvas/CanvasSaveStatus";
import { CanvasFramesProvider } from "@/app/components/canvas/CanvasFramesContext";
import {
  CanvasNodeMenu,
  type CanvasNodeMenuEntries,
} from "@/app/components/canvas/CanvasNodeMenu";
import { CanvasDropPreview } from "@/app/components/canvas/CanvasDropPreview";
import { CanvasKeyReady } from "@/app/components/canvas/CanvasKeyReady";
import { CanvasNoticeStrip } from "@/app/components/canvas/CanvasNotice";
import {
  CanvasRefusal,
  type CanvasRefusalHandle,
} from "@/app/components/canvas/CanvasRefusal";
import {
  AGENT_EDGE_STROKE,
  DeletableEdge,
} from "@/app/components/canvas/DeletableEdge";
import {
  connectionEdge,
  isCodeManagedEdge,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import { EmptyCanvasGuide } from "@/app/components/canvas/EmptyCanvasGuide";
import { SidePanelSlot } from "@/app/components/canvas/SidePanelSlot";
import { useEverTrue } from "@/app/hooks/useEverTrue";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { InfraAnalysisProvider } from "@/app/components/canvas/InfraAnalysisContext";
import { MountEdge } from "@/app/components/canvas/MountEdge";
import {
  NODE_TEMPLATES,
  NODE_TYPE_SHORTCUTS,
} from "@/app/components/canvas/nodeTemplates";
import { RunsOnEdge } from "@/app/components/canvas/RunsOnEdge";
import { SubagentEdge } from "@/app/components/canvas/SubagentEdge";
import { AgentNode } from "@/app/components/node/Agent";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { FrameNode } from "@/app/components/node/FrameNode";
import { SandboxNode } from "@/app/components/node/Sandbox";
import { SkillNode } from "@/app/components/node/Skill";
import { McpNode } from "@/app/components/node/Mcp";
import { WorkspaceNode } from "@/app/components/node/Workspace";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/app/components/ui/context-menu";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { useShortcut } from "@/app/components/ShortcutProvider";
import { useStage } from "@/app/hooks/useStage";
import {
  acceptsNewMember,
  autoWiredAgentIds,
  boardRects,
  cardLabel,
  frameGroupActions,
  introducedRuntimeRefsProblem,
  makeDefaultSandbox,
  nodeLinkActions,
  reconcileFramePositions,
  setUngrouped,
  setWorkspaceMount,
  workspaceMountTargets,
  type WorkspaceMountTarget,
} from "@/app/lib/canvasFrameEdits";
import {
  applyCanvasDrop,
  canvasDropTarget,
  pendingDropOf,
  sameCanvasDrop,
  type CanvasDrop,
} from "@/app/lib/canvasDropTarget";
import {
  applyFramedNodeChanges,
  buildFramedGraph,
  expandBundleEdgeRemoval,
  serversByNode,
  type FramedGraph,
} from "@/app/lib/canvasFrameNodes";
import {
  connectionRefusal,
  type ConnectionGraph,
} from "@/app/lib/canvasConnections";
import { toErrorMessage } from "@/app/lib/errors";
import { MOTION_MS, prefersReducedMotion } from "@/app/lib/motion";
import { reportPerf } from "@/app/lib/perfReport";
import { focusedNodeIds } from "@/app/lib/canvasFocus";
import {
  analyzeCanvasInfra,
  defaultRuntimeNodeData,
  deriveAgentRuntimeRefs,
  deriveSubagentRefs,
  runtimeRefsProblemText,
  serializeRuntimeRefs,
  serializeSubagentRefs,
  writeChangedRefs,
} from "@/app/lib/canvasRuntimeRefs";
import {
  applyPositions,
  applyTidyLayout,
  findFreePosition,
  GRID,
} from "@broods/convex/model/canvasLayout";
import { defaultStage } from "@broods/convex/model/defaultStage";
import { api } from "@broods/convex/_generated/api";
import {
  agreedSandboxOrderNumbers,
  workspaceOnlySandboxIds,
  type CanvasFrame,
} from "@broods/convex/model/canvasFrames";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  addEdge,
  applyEdgeChanges,
  Background,
  ConnectionMode,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Group } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Mounted only once wanted: a loading chunk holds the transition that mounts the canvas.
// `loading` gives each its own Suspense boundary; Turbopack rejects a shared options object.
const NodeSidePanel = dynamic(
  () =>
    import("@/app/components/NodeSidePanel").then((mod) => mod.NodeSidePanel),
  { loading: () => <div className="h-full w-full border-l bg-card" /> },
);
const AgentSourcePickerDialog = dynamic(
  () =>
    import("@/app/components/AgentSourcePickerDialog").then(
      (mod) => mod.AgentSourcePickerDialog,
    ),
  { loading: (): null => null },
);
const CreateAgentConfigDialog = dynamic(
  () =>
    import("@/app/components/CreateAgentConfigDialog").then(
      (mod) => mod.CreateAgentConfigDialog,
    ),
  { loading: (): null => null },
);
const NodeDeleteDialog = dynamic(
  () =>
    import("@/app/components/canvas/NodeDeleteDialog").then(
      (mod) => mod.NodeDeleteDialog,
    ),
  { loading: (): null => null },
);
const RenameNodeDialog = dynamic(
  () =>
    import("@/app/components/canvas/RenameNodeDialog").then(
      (mod) => mod.RenameNodeDialog,
    ),
  { loading: (): null => null },
);
const SkillSourcePickerDialog = dynamic(
  () =>
    import("@/app/components/SkillSourcePickerDialog").then(
      (mod) => mod.SkillSourcePickerDialog,
    ),
  { loading: (): null => null },
);

// React Flow's 20px misses a drop on a card's body; 100 reaches a 176x96 card's middle.
export const CONNECTION_RADIUS = 100;

export const CANVAS_NODE_TYPES = {
  agent: AgentNode,
  frame: FrameNode,
  sandbox: SandboxNode,
  workspace: WorkspaceNode,
  mcp: McpNode,
  skill: SkillNode,
};

export const CANVAS_EDGE_TYPES = {
  default: DeletableEdge,
  mount: MountEdge,
  runsOn: RunsOnEdge,
  subagent: SubagentEdge,
};

const PRO_OPTIONS = { hideAttribution: true } as const;
const SNAP_GRID: [number, number] = [GRID, GRID];

// One dimmed clone per source object, so a drag frame does not re-render every dimmed card.
const dimmedNodeCache = new WeakMap<Node, Node>();
const dimmedEdgeCache = new WeakMap<Edge, Edge>();

// Once per document: performance.now() counts from the first navigation.
let firstCanvasReported = false;

type FlowPosition = { x: number; y: number };

type StageData = {
  agentBadges:
    | FunctionReturnType<typeof api.agent.config.canvasBadges>
    | undefined;
  canvasLayout: FunctionReturnType<typeof api.canvas.getByProject> | undefined;
  mcpServers: FunctionReturnType<typeof api.mcp.listByStage> | undefined;
  machineConnections:
    | FunctionReturnType<typeof api.sandbox.machines.listForActiveOrg>
    | undefined;
};

export function Canvas({
  projectId,
}: {
  projectId: Id<"projects">;
}): React.JSX.Element {
  const { stageId, stageArgs } = useStage();
  const canvasLayout = useQuery(api.canvas.getByProject, stageArgs);
  const agentBadges = useQuery(api.agent.config.canvasBadges, stageArgs);
  const mcpServers = useQuery(api.mcp.listByStage, stageArgs);
  const machineConnections = useQuery(
    api.sandbox.machines.listForActiveOrg,
    stageArgs,
  );

  // Keyed per stage, or a pending save writes the old stage's graph into the new one.
  // The queries live out here so their subscriptions survive the remount.
  return (
    <ReactFlowProvider>
      <CanvasInner
        key={`${projectId}:${stageId ?? "loading"}`}
        projectId={projectId}
        agentBadges={stageId ? agentBadges : undefined}
        canvasLayout={stageId ? canvasLayout : undefined}
        mcpServers={stageId ? mcpServers : undefined}
        machineConnections={stageId ? machineConnections : undefined}
      />
    </ReactFlowProvider>
  );
}

// Ids read "<type>:{source}-{sourceHandle}-{target}-{targetHandle}"; CLI node ids hold hyphens.
function hydrateEncodedHandleEdge(
  edge: Edge,
  prefix: "mount:" | "subagent:",
  type: "mount" | "subagent",
): Edge {
  if (!edge.id.startsWith(prefix)) return edge;
  const payload = edge.id.slice(prefix.length);
  const parts = payload.split("-");
  if (parts.length === 4) {
    const [source, sourceHandle, target, targetHandle] = parts;

    return {
      ...edge,
      source: source,
      sourceHandle: sourceHandle,
      target: target,
      targetHandle: targetHandle,
      type: type,
      animated: false,
    };
  }

  const { source, target } = edge;
  if (source && target && payload.startsWith(`${source}-`)) {
    const rest = payload.slice(source.length + 1);
    const marker = `-${target}-`;
    const markerIndex = rest.indexOf(marker);
    if (markerIndex > -1) {
      return {
        ...edge,
        source: source,
        sourceHandle: rest.slice(0, markerIndex),
        target: target,
        targetHandle: rest.slice(markerIndex + marker.length),
        type: type,
        animated: false,
      };
    }
  }

  return edge;
}

function hydrateMountEdge(edge: Edge): Edge {
  return hydrateEncodedHandleEdge(edge, "mount:", "mount");
}

function hydrateSubagentEdge(edge: Edge): Edge {
  return hydrateEncodedHandleEdge(edge, "subagent:", "subagent");
}

function lockCodeManagedEdge(edge: Edge, nodesById: Map<string, Node>): Edge {
  if (!isCodeManagedEdge(edge, (nodeId) => nodesById.get(nodeId))) {
    return edge;
  }

  return { ...edge, deletable: false, reconnectable: false };
}

// Two nodes sharing an id make React Flow drag both at once.
function dedupeNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();

  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);

    return true;
  });
}

// Subagent links are directional (A→B and B→A coexist); other edges dedupe by unordered pair.
function dedupeEdges(edges: Edge[]): Edge[] {
  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();

  return edges.filter((e) => {
    const pair =
      e.type === "subagent"
        ? `sub:${e.source}>${e.target}`
        : e.source < e.target
          ? `${e.source}|${e.target}`
          : `${e.target}|${e.source}`;
    if (seenIds.has(e.id) || seenPairs.has(pair)) return false;
    seenIds.add(e.id);
    seenPairs.add(pair);

    return true;
  });
}

// Lets the DB sync skip our own save's echo: a reset to raw rows re-measures and flickers.
function layoutSignature(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    n: nodes.map((n) => [n.id, n.type, n.position.x, n.position.y, n.data]),
    e: edges.map((e) => [e.id, e.source, e.target, e.animated ?? false]),
  });
}

function readCollapsedFrames(key: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    );

    return new Set(
      Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeCollapsedFrames(key: string, ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Storage blocked or full: the toggle holds for this visit.
  }
}

function findNearestAgentNode(
  nodes: Node[],
  position: { x: number; y: number },
): Node | null {
  let nearest: Node | null = null;
  let nearestDist = Infinity;

  for (const node of nodes) {
    if (node.type !== "agent") continue;
    const dist = Math.hypot(
      node.position.x - position.x,
      node.position.y - position.y,
    );
    if (dist < nearestDist) {
      nearest = node;
      nearestDist = dist;
    }
  }

  return nearest;
}

function CanvasInner({
  projectId,
  agentBadges,
  canvasLayout,
  mcpServers,
  machineConnections,
}: {
  projectId: Id<"projects">;
} & StageData): React.JSX.Element {
  const { stageId } = useStage();
  const mcpServersByNode = useMemo(
    () => serversByNode(mcpServers ?? []),
    [mcpServers],
  );
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const defaultEdgeOptions = useMemo(
    () => ({
      style: {
        stroke: isDark ? AGENT_EDGE_STROKE.dark : AGENT_EDGE_STROKE.light,
        strokeWidth: 1.5,
      },
      // An animated edge repaints the canvas layer on every frame.
      animated: false,
    }),
    [isDark],
  );

  // Flat state, the shape that is saved. React Flow draws `framedGraph`.
  const [nodes, setNodes] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const collapsedKey = `canvas-collapsed-frames:${projectId}:${stageId}`;
  const [collapsedFrames, setCollapsedFrames] = useState(() =>
    readCollapsedFrames(collapsedKey),
  );
  const [drop, setDrop] = useState<CanvasDrop | null>(null);
  const [focusedFrameId, setFocusedFrameId] = useState<string | null>(null);
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const [nodeMenu, setNodeMenu] = useState<CanvasNodeMenuEntries | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedAt, setSelectedAt] = useState(0);
  const [saveState, setSaveState] = useState<CanvasSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resyncToken, setResyncToken] = useState(0);
  // Outlives the dialog's close, so its name does not blank mid fade-out.
  const [deleteNode, setDeleteNode] = useState<Node | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameNode, setRenameNode] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const emptyGuideRef = useRef<HTMLDivElement>(null);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [agentCreatePosition, setAgentCreatePosition] =
    useState<FlowPosition | null>(null);
  const { screenToFlowPosition, setCenter, getZoom, fitView, zoomIn, zoomOut } =
    useReactFlow();
  const searchParams = useSearchParams();
  const { canWrite } = useOrgRole();
  const nextId = useRef(1);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const lastRightClick = useRef<FlowPosition | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const isDraggingNode = useRef(false);
  // Read on release, when the state the preview renders from is a render behind.
  const dropRef = useRef<CanvasDrop | null>(null);
  const didInitialFit = useRef(false);
  const framedGraphRef = useRef<FramedGraph | null>(null);
  const savedLayoutRef = useRef(canvasLayout);

  const expandedMemberId = selectedNode?.id ?? null;
  const framedGraph = useMemo(
    () =>
      buildFramedGraph(
        nodes,
        edges,
        mcpServers,
        collapsedFrames,
        expandedMemberId,
        framedGraphRef.current,
        pendingDropOf(drop),
      ),
    [nodes, edges, mcpServers, collapsedFrames, expandedMemberId, drop],
  );

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- refs the flow callbacks read
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    framedGraphRef.current = framedGraph;
  }, [nodes, edges, framedGraph]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes((current) =>
        applyFramedNodeChanges(
          changes,
          current,
          edgesRef.current,
          mcpServers,
          collapsedFrames,
        ),
      );
    },
    [setNodes, mcpServers, collapsedFrames],
  );

  const toggleFrame = useCallback(
    (frameId: string) => {
      const next = new Set(collapsedFrames);
      if (!next.delete(frameId)) next.add(frameId);
      setCollapsedFrames(next);
      writeCollapsedFrames(collapsedKey, next);
    },
    [collapsedFrames, collapsedKey],
  );
  const saveLayoutMutation = useMutation(
    api.canvas.saveLayout,
  ).withOptimisticUpdate((localStore, args) => {
    // A bare URL reads the stage-less entry, which mirrors only the default stage.
    const layout = { nodes: args.nodes, edges: args.edges };
    localStore.setQuery(
      api.canvas.getByProject,
      { projectId: args.projectId, stageId: args.stageId },
      layout,
    );
    const stages = localStore.getQuery(api.stage.list, {
      projectId: args.projectId,
    });
    if (stages && defaultStage(stages)?._id === args.stageId) {
      localStore.setQuery(
        api.canvas.getByProject,
        { projectId: args.projectId },
        layout,
      );
    }
  });
  const updateRuntimeRefs = useMutation(api.agent.config.updateRuntimeRefs);
  const updateSubagentRefs = useMutation(api.agent.config.updateSubagentRefs);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLocalChanges = useRef(false);
  // A save from an older generation must not clear the dirty flag a newer edit set.
  const editGeneration = useRef(0);
  const lastRuntimeRefs = useRef(new Map<string, string>());
  const lastSubagentRefs = useRef(new Map<string, string>());

  const scheduleSave = useCallback(() => {
    hasLocalChanges.current = true;
    editGeneration.current += 1;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      if (!stageId) return;
      const generation = editGeneration.current;
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      // Config would refuse these refs once the layout landed: save nothing, restore the last.
      const saved = savedLayoutRef.current;
      const problem = introducedRuntimeRefsProblem(
        {
          edges: (saved?.edges ?? []) as Edge[],
          nodes: (saved?.nodes ?? []) as Node[],
        },
        { edges: currentEdges, nodes: currentNodes },
      );
      if (problem) {
        setSaveError(runtimeRefsProblemText(problem));
        setSaveState("error");
        hasLocalChanges.current = false;
        setResyncToken((token) => token + 1);

        return;
      }
      setSaveError(null);
      setSaveState("saving");
      const startedAt = performance.now();
      let refsFailed = false;
      saveLayoutMutation({
        projectId: projectId,
        stageId: stageId,
        nodes: currentNodes.map((n) => ({
          id: n.id,
          type: n.type as "agent" | "sandbox" | "workspace" | "mcp" | "skill",
          position: n.position,
          data: n.data as {
            label: string;
            status?: "running" | "idle" | "error";
            agentConfigId?: Id<"agentConfigs">;
            resourceId?: string;
            mountName?: string;
            description?: string;
            config?: Record<string, unknown>;
            properties?: { color: string };
            readOnly?: boolean;
          },
        })),
        edges: currentEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          animated: e.animated,
        })),
      })
        .then(async (savedLayout) => {
          // Merge back only changed `data` (fresh resourceIds): whole nodes drop sizes and drags.
          const persistedNodes = savedLayout.nodes as Node[];
          const persistedById = new Map(persistedNodes.map((n) => [n.id, n]));
          setNodes((current) => {
            let changed = false;
            const next = current.map((n) => {
              const persisted = persistedById.get(n.id);
              if (
                !persisted ||
                JSON.stringify(persisted.data) === JSON.stringify(n.data)
              ) {
                return n;
              }
              changed = true;

              return { ...n, data: persisted.data };
            });

            return changed ? next : current;
          });

          // Settled together, so one failed group does not skip the other.
          const refWrites = await Promise.allSettled([
            writeChangedRefs(
              deriveAgentRuntimeRefs(persistedNodes, currentEdges),
              lastRuntimeRefs.current,
              serializeRuntimeRefs,
              (ref) =>
                updateRuntimeRefs({
                  configId: ref.configId,
                  sandboxes: ref.sandboxes,
                  workspaces: ref.workspaces.length > 0 ? ref.workspaces : null,
                }),
            ),
            writeChangedRefs(
              deriveSubagentRefs(persistedNodes, currentEdges),
              lastSubagentRefs.current,
              serializeSubagentRefs,
              (ref) =>
                updateSubagentRefs({
                  configId: ref.configId,
                  calleeConfigIds: ref.calleeConfigIds,
                }),
            ),
          ]);
          const failed = refWrites.find((r) => r.status === "rejected");
          if (failed?.status === "rejected") {
            refsFailed = true;
            throw failed.reason;
          }
        })
        .then(() => {
          reportPerf("optimistic-save", performance.now() - startedAt, {
            attributes: { outcome: "committed", nodes: currentNodes.length },
          });
          if (editGeneration.current !== generation) return;
          hasLocalChanges.current = false;
          setSaveState("saved");
        })
        .catch((error: unknown) => {
          reportPerf("optimistic-save", performance.now() - startedAt, {
            attributes: {
              outcome: refsFailed ? "refs-failed" : "rolled-back",
              nodes: currentNodes.length,
            },
          });
          // Back to the database: a held dirty flag let a later save overwrite CLI deploys.
          if (editGeneration.current === generation) {
            hasLocalChanges.current = false;
          }
          setSaveError(toErrorMessage(error));
          setSaveState("error");
        });
    }, 500);
  }, [
    stageId,
    projectId,
    saveLayoutMutation,
    setNodes,
    updateRuntimeRefs,
    updateSubagentRefs,
  ]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- clears the save timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- Convex layout into flow state
  useEffect(() => {
    savedLayoutRef.current = canvasLayout;
    if (hasLocalChanges.current || isDraggingNode.current) return;

    if (canvasLayout) {
      const persistedEdges = canvasLayout.edges as Edge[];
      const incoming = layoutSignature(
        canvasLayout.nodes as Node[],
        persistedEdges,
      );
      if (incoming !== layoutSignature(nodesRef.current, edgesRef.current)) {
        const nextNodes = dedupeNodes(canvasLayout.nodes as Node[]);
        const nodesById = new Map(nextNodes.map((node) => [node.id, node]));
        setNodes(nextNodes);
        setEdges(
          dedupeEdges(
            persistedEdges
              .map(hydrateMountEdge)
              .map(hydrateSubagentEdge)
              .map((edge) => lockCodeManagedEdge(edge, nodesById)),
          ),
        );
        const maxId = canvasLayout.nodes.reduce(
          (max: number, n: { id: string }) => Math.max(max, Number(n.id) || 0),
          0,
        );
        nextId.current = maxId + 1;
      }

      // The `fitView` prop fires on mount, before the layout has loaded.
      if (!didInitialFit.current) {
        didInitialFit.current = true;
        if (canvasLayout.nodes.length > 0) {
          void fitView(FIT_VIEW_OPTIONS).catch((error: unknown): void => {
            console.error("Failed to fit the canvas view", error);
          });
        }
        if (!firstCanvasReported) {
          firstCanvasReported = true;
          requestAnimationFrame(() =>
            reportPerf("first-load.canvas", performance.now(), {
              attributes: { nodes: canvasLayout.nodes.length },
            }),
          );
        }
      }
    } else {
      setNodes([]);
      setEdges([]);
      nextId.current = 1;
    }
  }, [canvasLayout, resyncToken, setNodes, setEdges, fitView]);

  // The refs update at once, so a second edit in the same event builds on this one.
  const editGraph = useCallback(
    (
      edit: (nodes: Node[], edges: Edge[]) => { edges: Edge[]; nodes: Node[] },
    ): void => {
      const next = edit(nodesRef.current, edgesRef.current);
      const settled = reconcileFramePositions(
        {
          edges: edgesRef.current,
          mcpServers: mcpServers,
          nodes: nodesRef.current,
        },
        { edges: next.edges, mcpServers: mcpServers, nodes: next.nodes },
      );
      nodesRef.current = settled;
      edgesRef.current = next.edges;
      setNodes(settled);
      setEdges(next.edges);
      scheduleSave();
    },
    [mcpServers, setNodes, setEdges, scheduleSave],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const bundles =
        framedGraphRef.current?.bundles ?? new Map<string, string[]>();
      const expanded: EdgeChange[] = expandBundleEdgeRemoval(changes, bundles);
      if (!expanded.some((change) => change.type === "remove")) {
        setEdges((current) => applyEdgeChanges(expanded, current));

        return;
      }
      editGraph((nodes, edges) => ({
        edges: applyEdgeChanges(expanded, edges),
        nodes: nodes,
      }));
    },
    [setEdges, editGraph],
  );

  const lastMcpServers = useRef(mcpServers);
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- Convex MCP transports re-frame
  useEffect(() => {
    const before = lastMcpServers.current;
    lastMcpServers.current = mcpServers;
    if (before === undefined || mcpServers === undefined) return;
    const settled = reconcileFramePositions(
      { edges: edgesRef.current, mcpServers: before, nodes: nodesRef.current },
      {
        edges: edgesRef.current,
        mcpServers: mcpServers,
        nodes: nodesRef.current,
      },
    );
    if (settled === nodesRef.current) return;
    nodesRef.current = settled;
    setNodes(settled);
    if (canWrite) scheduleSave();
  }, [mcpServers, canWrite, setNodes, scheduleSave]);

  // Waits out the panel's enter: a pan during it re-renders every card per frame.
  const lastFocusedNode = useRef<Node | null>(null);
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- timer, React Flow viewport
  useEffect(() => {
    const node = selectedNode ?? lastFocusedNode.current;
    if (selectedNode) lastFocusedNode.current = selectedNode;
    if (!node) return;

    const id = window.setTimeout(() => {
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      void setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        {
          zoom: getZoom(),
          duration: prefersReducedMotion() ? 0 : MOTION_MS.slow,
        },
      ).catch((error: unknown): void => {
        console.error("Failed to center the selected canvas node", error);
      });
      if (!selectedNode) lastFocusedNode.current = null;
    }, MOTION_MS.base);

    return () => window.clearTimeout(id);
  }, [selectedNode, setCenter, getZoom]);

  const getConnectionGraph = useCallback(
    (): ConnectionGraph => ({
      edges: edgesRef.current,
      nodes: nodesRef.current,
    }),
    [],
  );
  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean =>
      connectionRefusal(getConnectionGraph(), connection) === null,
    [getConnectionGraph],
  );
  const refusalRef = useRef<CanvasRefusalHandle>(null);
  const clearRefusal = useCallback((): void => refusalRef.current?.clear(), []);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connection): void =>
      refusalRef.current?.onConnectEnd(event, connection),
    [],
  );

  const onConnect: OnConnect = useCallback(
    (params) => {
      const edge = connectionEdge(
        params,
        nodesRef.current.find((n): boolean => n.id === params.source)?.type ===
          "agent",
      );

      editGraph((nodes, edges) => ({
        edges: addEdge(edge, edges),
        nodes: nodes,
      }));
    },
    [editGraph],
  );

  const getViewportCenterPosition = useCallback((): FlowPosition => {
    const bounds = canvasContainerRef.current?.getBoundingClientRect();
    const clientX = bounds
      ? bounds.left + bounds.width / 2
      : typeof window !== "undefined"
        ? window.innerWidth / 2
        : 0;
    const clientY = bounds
      ? bounds.top + bounds.height / 2
      : typeof window !== "undefined"
        ? window.innerHeight / 2
        : 0;

    return screenToFlowPosition({ x: clientX, y: clientY });
  }, [screenToFlowPosition]);

  // Built on demand: a memo on the graph would rebuild on every frame of a drag.
  const buildNodeMenu = useCallback(
    (nodeId: string): CanvasNodeMenuEntries | null => {
      const menuNode = nodesRef.current.find((node) => node.id === nodeId);
      if (!menuNode) return null;

      return {
        deleteLocked: isCodeManagedOwner(menuNode.data.managedBy),
        groups: frameGroupActions(
          {
            edges: edgesRef.current,
            mcpServers: mcpServers,
            nodes: nodesRef.current,
          },
          menuNode.id,
        ),
        label: cardLabel(menuNode),
        links: nodeLinkActions(nodesRef.current, edgesRef.current, menuNode.id),
        mounts: workspaceMountTargets(
          nodesRef.current,
          edgesRef.current,
          menuNode.id,
        ),
        nodeId: menuNode.id,
      };
    },
    [mcpServers],
  );

  const onContextMenu = useCallback(
    (event: React.MouseEvent): void => {
      clearRefusal();
      lastRightClick.current = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const nodeElement =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(".react-flow__node")
          : null;
      const nodeId = nodeElement?.dataset.id ?? null;
      setMenuNodeId(nodeId);
      setNodeMenu(nodeId === null ? null : buildNodeMenu(nodeId));
    },
    [buildNodeMenu, clearRefusal, screenToFlowPosition],
  );

  // Consumes the right-click point, so a later add from a key lands in view.
  const getFreeAddPosition = useCallback((): FlowPosition => {
    const requested = lastRightClick.current ?? getViewportCenterPosition();
    lastRightClick.current = null;

    const graph = framedGraphRef.current;

    return findFreePosition(
      requested,
      graph ? boardRects(graph.nodes, graph.frames) : [],
    );
  }, [getViewportCenterPosition]);

  const addNode = useCallback(
    (
      type: string,
      label: string,
      extraData?: Partial<BaseNodeData>,
      agentIds?: readonly string[],
    ) => {
      const position = getFreeAddPosition();
      const id = String(nextId.current++);
      const nodeLabel = `${label} ${id}`;

      const newNode: Node = {
        id: id,
        type: type,
        position: position,
        data: { ...defaultRuntimeNodeData(type, nodeLabel, id), ...extraData },
      };

      const nearest = findNearestAgentNode(nodesRef.current, position);
      const sources = autoWiredAgentIds(
        nodesRef.current,
        agentIds ?? (nearest ? [nearest.id] : []),
      );
      const newEdges: Edge[] = sources.map((source) =>
        connectionEdge(
          {
            source: source,
            sourceHandle: null,
            target: id,
            targetHandle: null,
          },
          true,
        ),
      );
      editGraph((nodes, edges) => ({
        edges: [...edges, ...newEdges],
        nodes: [...nodes, newNode],
      }));
    },
    [getFreeAddPosition, editGraph],
  );

  const addToFrame = useCallback(
    (frame: CanvasFrame) => {
      const template = NODE_TEMPLATES.find((item) => item.type === frame.kind);
      if (!template) return;
      addNode(template.type, template.label, undefined, frame.ownerIds);
    },
    [addNode],
  );

  const tidyLayout = useCallback(() => {
    setNodes((nds) => applyTidyLayout(nds, edgesRef.current, mcpServersByNode));
    scheduleSave();
    window.requestAnimationFrame(() => fitView(FIT_VIEW_OPTIONS));
  }, [setNodes, scheduleSave, fitView, mcpServersByNode]);

  const makeDefault = useCallback(
    (agentId: string, sandboxId: string) => {
      editGraph((nodes, edges) => ({
        edges: edges,
        nodes: makeDefaultSandbox(nodes, edges, agentId, sandboxId),
      }));
    },
    [editGraph],
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      editGraph((nodes, edges) => ({
        edges: edges.filter((edge) => edge.id !== edgeId),
        nodes: nodes,
      }));
    },
    [editGraph],
  );

  const setNodesUngrouped = useCallback(
    (nodeIds: readonly string[], ungrouped: boolean) => {
      editGraph((nodes, edges) => ({
        edges: edges,
        nodes: setUngrouped(nodes, nodeIds, ungrouped),
      }));
    },
    [editGraph],
  );

  const onNodeDragStart: OnNodeDrag = useCallback(() => {
    isDraggingNode.current = true;
    clearRefusal();
  }, [clearRefusal]);

  const onNodeDrag: OnNodeDrag = useCallback(
    (_event, grabbed, dragged) => {
      const next =
        dragged.length === 1 && grabbed.type !== "frame"
          ? canvasDropTarget({
              collapsedFrames: collapsedFrames,
              expandedMemberId: expandedMemberId,
              graph: {
                edges: edgesRef.current,
                mcpServers: mcpServers,
                nodes: nodesRef.current,
              },
              nodeId: grabbed.id,
              position: grabbed.position,
            })
          : null;
      if (sameCanvasDrop(dropRef.current, next)) return;
      dropRef.current = next;
      setDrop(next);
    },
    [collapsedFrames, expandedMemberId, mcpServers],
  );

  // React Flow's grid snap lets cards land on each other: each steps to a clear spot.
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, grabbed, dragged) => {
      isDraggingNode.current = false;
      const pending = dropRef.current;
      dropRef.current = null;
      setDrop(null);
      if (pending?.refusal === null && pending.nodeId === grabbed.id) {
        editGraph((nodes, edges) =>
          applyCanvasDrop(
            { edges: edges, mcpServers: mcpServers, nodes: nodes },
            pending,
          ),
        );

        return;
      }
      const draggedIds = new Set(dragged.map((node) => node.id));
      const graph = framedGraphRef.current;
      // Dragged frames count where they were dropped, which the last render does not know.
      const occupied = boardRects(
        [
          ...(graph?.nodes ?? []).filter((node) => !draggedIds.has(node.id)),
          ...dragged.filter((node) => node.type === "frame"),
        ],
        graph?.frames ?? [],
      );
      const settled = new Map<string, FlowPosition>();
      const ordered = [
        grabbed,
        ...dragged.filter((node) => node.id !== grabbed.id),
      ].filter((node) => node.type !== "frame");
      for (const node of ordered) {
        const position = findFreePosition(node.position, occupied);
        occupied.push(...boardRects([{ ...node, position: position }], []));
        settled.set(node.id, position);
      }
      setNodes((nds) => applyPositions(nds, settled));
      scheduleSave();
    },
    [setNodes, scheduleSave, editGraph, mcpServers],
  );

  const onNodesDelete = useCallback(() => {
    setSelectedNode(null);
    scheduleSave();
  }, [scheduleSave]);

  const openNode = useCallback((nodeId: string): void => {
    // The flat node, so the panel and the re-centre read absolute positions.
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    setFocusedFrameId(null);
    setSelectedAt(performance.now());
    setSelectedNode(node);
  }, []);

  const requestNodeDelete = useCallback((nodeId: string): void => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    setDeleteNode(node);
    setDeleteOpen(true);
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      clearRefusal();
      if (node.type === "frame") {
        setSelectedNode(null);
        setFocusedFrameId(node.id);

        return;
      }
      openNode(node.id);
    },
    [clearRefusal, openNode],
  );

  const onPaneClick = useCallback(() => {
    clearRefusal();
    setSelectedNode(null);
    setFocusedFrameId(null);
  }, [clearRefusal]);
  const onOpenCreateConfig = useCallback(
    (position?: FlowPosition) => {
      setAgentCreatePosition(position ?? getFreeAddPosition());
      setConfigDialogOpen(true);
    },
    [getFreeAddPosition],
  );
  const onConfigDialogOpenChange = useCallback((open: boolean) => {
    setConfigDialogOpen(open);
    if (!open) setAgentCreatePosition(null);
  }, []);
  const onOpenSourcePicker = useCallback(() => {
    // The empty guide lists the sources: focus it after a closing menu hands focus back.
    const emptyGuide = emptyGuideRef.current;
    if (emptyGuide) {
      requestAnimationFrame(() =>
        emptyGuide
          .querySelector<HTMLButtonElement>("button:enabled")
          ?.focus({ focusVisible: true }),
      );

      return;
    }
    setAgentCreatePosition(getFreeAddPosition());
    setSourcePickerOpen(true);
  }, [getFreeAddPosition]);
  useShortcut("canvas.addAgent", () => canWrite && onOpenSourcePicker());
  useShortcut("canvas.addSkill", () => canWrite && setSkillPickerOpen(true));
  useShortcut(
    "canvas.addSandbox",
    () => canWrite && addNode("sandbox", "Sandbox"),
  );
  useShortcut(
    "canvas.addWorkspace",
    () => canWrite && addNode("workspace", "Workspace"),
  );
  useShortcut("canvas.addMcp", () => canWrite && addNode("mcp", "MCP"));
  useShortcut("canvas.rename", () => {
    if (!canWrite || !selectedNode) return;
    const label = selectedNode.data.label;
    setRenameNode({
      id: selectedNode.id,
      label: typeof label === "string" ? label : "",
    });
  });
  useShortcut("canvas.delete", () => {
    if (canWrite && selectedNode) requestNodeDelete(selectedNode.id);
  });
  useShortcut("canvas.open", () => {
    if (selectedNode) openNode(selectedNode.id);
  });
  useShortcut("canvas.group", () => {
    if (!canWrite || !selectedNode) return;
    const action = buildNodeMenu(selectedNode.id)?.groups[0];
    if (action) setNodesUngrouped(action.nodeIds, action.kind !== "rejoin");
  });
  useShortcut("canvas.makeDefault", () => {
    if (!canWrite || !selectedNode) return;
    const link = buildNodeMenu(selectedNode.id)?.links.find(
      (entry) => entry.kind === "make-default" && !entry.disabledReason,
    );
    if (link?.kind === "make-default")
      makeDefault(link.agentId, selectedNode.id);
  });
  useShortcut("canvas.fitView", () => fitView(FIT_VIEW_OPTIONS));
  useShortcut("canvas.tidy", () => canWrite && tidyLayout());
  useShortcut("canvas.zoomIn", () => zoomIn());
  useShortcut("canvas.zoomOut", () => zoomOut());

  const requestedNodeId = searchParams.get("node");
  const hasRequestedNode = nodes.some((node) => node.id === requestedNodeId);
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- router ?node= opens its card
  useEffect(() => {
    if (requestedNodeId && hasRequestedNode) openNode(requestedNodeId);
  }, [hasRequestedNode, openNode, requestedNodeId]);

  const onCreateAgentFromPicker = useCallback(() => {
    onOpenCreateConfig(agentCreatePosition ?? getFreeAddPosition());
  }, [agentCreatePosition, getFreeAddPosition, onOpenCreateConfig]);

  const onEdgesDeleteHandler = useCallback(() => {
    scheduleSave();
  }, [scheduleSave]);

  const onSkillSelect = useCallback(
    (source: "files" | "github" | "json") => {
      addNode("skill", "Skill", { config: { skillSource: source } });
    },
    [addNode],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      editGraph((nodes, edges) => ({
        edges: edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
        nodes: nodes.filter((n) => n.id !== nodeId),
      }));
      setSelectedNode(null);
    },
    [editGraph],
  );

  const updateNodeLabel = useCallback(
    (nodeId: string, label: string) => {
      editGraph((nodes, edges) => ({
        edges: edges,
        nodes: nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, label: label } } : n,
        ),
      }));
      setSelectedNode((current) =>
        current?.id === nodeId
          ? { ...current, data: { ...current.data, label: label } }
          : current,
      );
    },
    [editGraph],
  );

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<BaseNodeData>) => {
      editGraph((nodes, edges) => ({
        edges: edges,
        nodes: nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      }));
      setSelectedNode((current) =>
        current?.id === nodeId
          ? { ...current, data: { ...current.data, ...patch } }
          : current,
      );
    },
    [editGraph],
  );

  const mountTargetsOf = useCallback(
    (workspaceId: string): WorkspaceMountTarget[] =>
      canWrite
        ? workspaceMountTargets(nodesRef.current, edgesRef.current, workspaceId)
        : [],
    [canWrite],
  );

  const setWorkspaceMountTarget = useCallback(
    (workspaceId: string, target: WorkspaceMountTarget): void => {
      editGraph((nodes, edges) =>
        setWorkspaceMount(
          { edges: edges, mcpServers: mcpServers, nodes: nodes },
          workspaceId,
          target,
        ),
      );
    },
    [editGraph, mcpServers],
  );

  const isLoading = canvasLayout === undefined;
  const isEmpty = !isLoading && nodes.length === 0;

  const infraKey = useMemo(
    () =>
      JSON.stringify({
        n: nodes.map((n) => {
          const d = n.data as BaseNodeData;

          return [
            n.id,
            n.type,
            d?.resourceId,
            d?.label,
            d?.mountName,
            d?.readOnly === true,
            n.data.sandboxOrder,
          ];
        }),
        e: edges.map((e) => [e.source, e.target, e.type]),
      }),
    [nodes, edges],
  );
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- infraKey has no positions: drags skip
  const topology = useMemo(() => ({ edges: edges, nodes: nodes }), [infraKey]);
  const { infraAnalysis, orderNumbers, workspaceOnly } = useMemo(
    () => ({
      infraAnalysis: analyzeCanvasInfra(topology.nodes, topology.edges),
      orderNumbers: agreedSandboxOrderNumbers(topology.nodes, topology.edges),
      workspaceOnly: workspaceOnlySandboxIds(topology.nodes, topology.edges),
    }),
    [topology],
  );
  const framesContext = useMemo(
    () => ({
      agentBadges: agentBadges,
      canWrite: canWrite,
      expandedMemberId: expandedMemberId,
      machineConnections: machineConnections,
      mcpServers: mcpServersByNode,
      mountTargetsOf: mountTargetsOf,
      onRenameNode: updateNodeLabel,
      onSetWorkspaceMount: setWorkspaceMountTarget,
      onToggleFrame: toggleFrame,
      sandboxOrderNumbers: orderNumbers,
      workspaceOnlySandboxIds: workspaceOnly,
    }),
    [
      agentBadges,
      canWrite,
      expandedMemberId,
      machineConnections,
      mcpServersByNode,
      mountTargetsOf,
      updateNodeLabel,
      setWorkspaceMountTarget,
      toggleFrame,
      orderNumbers,
      workspaceOnly,
    ],
  );
  const frameMenu = useMemo(() => {
    const frame = framedGraph.frames.find((item) => item.id === menuNodeId);

    return frame && acceptsNewMember(frame) ? frame : null;
  }, [menuNodeId, framedGraph]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- rAF commit-to-paint sample
  useEffect(() => {
    const startedAt = performance.now();
    const frame = requestAnimationFrame(() => {
      reportPerf("canvas.render", performance.now() - startedAt, {
        attributes: {
          nodes: topology.nodes.length,
          edges: topology.edges.length,
        },
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [topology]);

  const focusedFrameMembers = useMemo(
    () =>
      framedGraph.frames.find((frame) => frame.id === focusedFrameId)
        ?.memberIds ?? [],
    [framedGraph.frames, focusedFrameId],
  );
  const focusedFrameKey = focusedFrameMembers.join("\n");
  const focusedIds = useMemo(() => {
    const seeds = selectedNode
      ? [selectedNode.id]
      : focusedFrameKey
        ? focusedFrameKey.split("\n")
        : [];

    return seeds.length === 0
      ? null
      : focusedNodeIds(topology.nodes, topology.edges, seeds);
  }, [selectedNode, focusedFrameKey, topology]);

  const litIds = useMemo(() => {
    if (!focusedIds) return null;
    const lit = new Set(focusedIds);
    for (const frame of framedGraph.frames) {
      if (frame.memberIds.some((id) => focusedIds.has(id))) lit.add(frame.id);
    }

    return lit;
  }, [focusedIds, framedGraph.frames]);

  const displayNodes = useMemo(() => {
    if (!litIds) return framedGraph.nodes;

    return framedGraph.nodes.map((n) => {
      if (litIds.has(n.id)) return n;
      let dimmed = dimmedNodeCache.get(n);
      if (!dimmed) {
        dimmed = { ...n, style: { ...n.style, opacity: 0.25 } };
        dimmedNodeCache.set(n, dimmed);
      }

      return dimmed;
    });
  }, [framedGraph.nodes, litIds]);

  const displayEdges = useMemo(() => {
    const base = dedupeEdges(framedGraph.edges);
    if (!litIds) return base;

    return base.map((e) => {
      if (litIds.has(e.source) && litIds.has(e.target)) return e;
      let dimmed = dimmedEdgeCache.get(e);
      if (!dimmed) {
        dimmed = { ...e, style: { ...e.style, opacity: 0.12 } };
        dimmedEdgeCache.set(e, dimmed);
      }

      return dimmed;
    });
  }, [framedGraph.edges, litIds]);

  const flow = (
    <ReactFlow
      nodes={displayNodes}
      edges={displayEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectStart={clearRefusal}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      onNodeDrag={onNodeDrag}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDeleteHandler}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      nodesDraggable={canWrite}
      nodesConnectable={canWrite}
      snapToGrid
      snapGrid={SNAP_GRID}
      nodeTypes={CANVAS_NODE_TYPES}
      edgeTypes={CANVAS_EDGE_TYPES}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={CONNECTION_RADIUS}
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      maxZoom={1.5}
      deleteKeyCode={null}
      colorMode={isDark ? "dark" : "light"}
      proOptions={PRO_OPTIONS}
      defaultEdgeOptions={defaultEdgeOptions}
    >
      <Background
        bgColor={isDark ? "#000" : undefined}
        color={isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.16)"}
        gap={GRID}
        size={2}
      />
      <Panel position="top-left">
        <CanvasControls onTidy={tidyLayout} />
      </Panel>
      <CanvasNoticeStrip>
        <CanvasKeyReady projectId={projectId} stageId={stageId} />
        <CanvasRefusal ref={refusalRef} getGraph={getConnectionGraph} />
        <CanvasDropPreview drop={drop} />
        <CanvasSaveStatus
          state={saveState}
          message={saveError}
          onRetry={scheduleSave}
        />
      </CanvasNoticeStrip>
    </ReactFlow>
  );

  const sidePanelWanted = useEverTrue(selectedNode !== null);
  const sourcePickerWanted = useEverTrue(sourcePickerOpen);
  const configDialogWanted = useEverTrue(configDialogOpen);
  const skillPickerWanted = useEverTrue(skillPickerOpen);

  return (
    <InfraAnalysisProvider value={infraAnalysis}>
      <div className="relative flex size-full overflow-hidden">
        <div
          ref={canvasContainerRef}
          className="relative h-full min-w-0 flex-1 overflow-hidden"
        >
          <ContextMenu>
            <ContextMenuTrigger
              className="size-full"
              onContextMenu={onContextMenu}
            >
              <CanvasFramesProvider value={framesContext}>
                {flow}
              </CanvasFramesProvider>
            </ContextMenuTrigger>
            {canWrite && nodeMenu && (
              <ContextMenuContent className="w-60">
                <CanvasNodeMenu
                  {...nodeMenu}
                  onOpen={openNode}
                  onDelete={requestNodeDelete}
                  onMakeDefault={makeDefault}
                  onRemoveEdge={removeEdge}
                  onRename={(id, label) =>
                    setRenameNode({ id: id, label: label })
                  }
                  onSetMount={setWorkspaceMountTarget}
                  onSetUngrouped={setNodesUngrouped}
                />
              </ContextMenuContent>
            )}
            {canWrite && !nodeMenu && frameMenu && (
              <ContextMenuContent className="w-56">
                <ContextMenuGroup>
                  <ContextMenuLabel
                    variant="muted"
                    className="text-xs tracking-wider"
                  >
                    {frameMenu.label}
                  </ContextMenuLabel>
                  <ContextMenuItem
                    className="cursor-pointer"
                    onClick={() => addToFrame(frameMenu)}
                  >
                    <Group />
                    Add to this group
                  </ContextMenuItem>
                </ContextMenuGroup>
              </ContextMenuContent>
            )}
            {canWrite && !nodeMenu && !frameMenu && (
              <ContextMenuContent className="w-48">
                <ContextMenuGroup>
                  <ContextMenuLabel
                    variant="muted"
                    className="text-xs tracking-wider"
                  >
                    Add service
                  </ContextMenuLabel>
                </ContextMenuGroup>
                {NODE_TEMPLATES.map(({ type, label, icon: Icon }, index) => (
                  <Fragment key={type}>
                    {index === NODE_TEMPLATES.length - 1 && (
                      <ContextMenuSeparator />
                    )}
                    <ContextMenuItem
                      className="cursor-pointer"
                      onClick={() =>
                        type === "agent"
                          ? onOpenSourcePicker()
                          : type === "skill"
                            ? setSkillPickerOpen(true)
                            : addNode(type, label)
                      }
                    >
                      <Icon />
                      {label}
                      <ShortcutKeys
                        id={NODE_TYPE_SHORTCUTS[type]}
                        className="ml-auto"
                      />
                    </ContextMenuItem>
                  </Fragment>
                ))}
              </ContextMenuContent>
            )}
          </ContextMenu>

          {isEmpty && canWrite && (
            <EmptyCanvasGuide
              ref={emptyGuideRef}
              onCreateConfig={() => onOpenCreateConfig()}
            />
          )}
          {isEmpty && !canWrite && (
            <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
              No services yet. An org admin can add one.
            </p>
          )}
        </div>

        {sidePanelWanted && (
          <SidePanelSlot node={selectedNode}>
            {(node) => (
              <NodeSidePanel
                node={node}
                selectedAt={selectedAt}
                onClose={onPaneClick}
                onRequestDelete={requestNodeDelete}
                onUpdateNodeLabel={updateNodeLabel}
                onUpdateNodeData={updateNodeData}
              />
            )}
          </SidePanelSlot>
        )}

        {deleteNode && (
          <NodeDeleteDialog
            key={deleteNode.id}
            node={deleteNode}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onRemoved={removeNode}
          />
        )}

        {renameNode && (
          <RenameNodeDialog
            key={renameNode.id}
            label={renameNode.label}
            nodeId={renameNode.id}
            open={true}
            onOpenChange={() => setRenameNode(null)}
            onRename={updateNodeLabel}
          />
        )}

        {sourcePickerWanted && (
          <AgentSourcePickerDialog
            open={sourcePickerOpen}
            onOpenChange={setSourcePickerOpen}
            onCreateNew={onCreateAgentFromPicker}
          />
        )}

        {configDialogWanted && (
          <CreateAgentConfigDialog
            projectId={projectId}
            stageId={stageId}
            open={configDialogOpen}
            onOpenChange={onConfigDialogOpenChange}
            initialCanvasPosition={agentCreatePosition}
          />
        )}

        {skillPickerWanted && (
          <SkillSourcePickerDialog
            open={skillPickerOpen}
            onOpenChange={setSkillPickerOpen}
            onSelect={onSkillSelect}
          />
        )}
      </div>
    </InfraAnalysisProvider>
  );
}
