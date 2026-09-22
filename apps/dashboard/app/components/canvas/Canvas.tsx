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
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { InfraAnalysisProvider } from "@/app/components/canvas/InfraAnalysisContext";
import { MountEdge } from "@/app/components/canvas/MountEdge";
import { NODE_TEMPLATES } from "@/app/components/canvas/nodeTemplates";
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
import { reportPerf } from "@/app/lib/perfReport";
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
import { Group } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Interaction-only components, loaded the first time they are wanted. They
// must not render before that: a lazy child that is still loading holds the
// transition that mounts the canvas, and the stage landing in the URL is
// such a transition, so the first paint waited for dialog code nobody opened.
//
// Every one of them passes `loading`, because that is what buys a chunk its
// own Suspense boundary. Without one the first open suspends all the way up
// to the route's `loading.tsx` and the whole canvas blinks to "Loading
// canvas…" while the chunk downloads. A dialog shows nothing before it opens,
// so its fallback is null. The option object is spelled out at each call:
// Turbopack reads it statically and rejects a shared constant.
const NodeSidePanel = dynamic(
  () =>
    import("@/app/components/NodeSidePanel").then((mod) => mod.NodeSidePanel),
  { loading: () => <div className="h-full w-full" /> },
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

/**
 * How far from a handle a drop still lands on it. React Flow's default is 20px,
 * which is smaller than the nodes: a drop on the body of a card or a chip sat
 * outside every handle and silently did nothing. 100 reaches every pixel of a
 * 176x44 chip and a 176x96 card's middle from its top handle, so dropping on a
 * node connects to it. Side handles stay the nearest along a card's left and
 * right edges, which is where a mount is aimed.
 */
export const CONNECTION_RADIUS = 100;

/** Node and edge components by type; the UI gallery draws its canvas fixture with them too. */
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

/** Static ReactFlow options hoisted outside components to avoid object churn on re-renders. */
const PRO_OPTIONS = { hideAttribution: true } as const;
/** Drags step along the background dots, the same pitch the tidy layout cells sit on. */
const SNAP_GRID: [number, number] = [GRID, GRID];

/**
 * Focus-mode dim caches, keyed by source object identity. Reusing the dimmed clone keeps
 * unchanged elements referentially stable across drag frames. Fresh clones each frame
 * would re-render every dimmed node/edge at 60fps. WeakMap entries follow their keys' GC.
 */
const dimmedNodeCache = new WeakMap<Node, Node>();
const dimmedEdgeCache = new WeakMap<Edge, Edge>();

// Once per document: a later client-side navigation mounts a new canvas, but
// performance.now() still counts from the first navigation.
let firstCanvasReported = false;

type FlowPosition = { x: number; y: number };

export function Canvas({
  projectId,
}: {
  projectId: Id<"projects">;
}): React.JSX.Element {
  const { stageId } = useStage();

  // Remount per stage: a stage switch with a debounced save pending would
  // otherwise keep the old stage's graph on screen (hasLocalChanges blocks the
  // sync) and the next edit would persist it into the new stage.
  return (
    <ReactFlowProvider>
      <CanvasInner
        key={`${projectId}:${stageId ?? "loading"}`}
        projectId={projectId}
      />
    </ReactFlowProvider>
  );
}

function hydrateEncodedHandleEdge(
  edge: Edge,
  prefix: "mount:" | "subagent:",
  type: "mount" | "subagent",
): Edge {
  if (!edge.id.startsWith(prefix)) return edge;
  const payload = edge.id.slice(prefix.length);
  const parts = payload.split("-");
  // parts: [source, sourceHandle, target, targetHandle]. Works for numeric
  // dashboard node ids that contain no hyphens.
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

  // CLI-synced node ids contain hyphens (e.g. `cli-agent-foo`), so the split
  // above is ambiguous. The persisted edge still carries source/target, so peel
  // off the two handle tokens that wrap the target id in the payload.
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

/**
 * Reconstruct mount edge properties from the encoded ID.
 * Format: "mount:{source}-{sourceHandle}-{target}-{targetHandle}"
 */
function hydrateMountEdge(edge: Edge): Edge {
  return hydrateEncodedHandleEdge(edge, "mount:", "mount");
}

/**
 * Reconstruct subagent edge properties from the encoded ID.
 * Format: "subagent:{source}-{sourceHandle}-{target}-{targetHandle}"
 */
function hydrateSubagentEdge(edge: Edge): Edge {
  return hydrateEncodedHandleEdge(edge, "subagent:", "subagent");
}

/** Mark code-managed edges non-deletable; pass dashboard-owned edges through. */
function lockCodeManagedEdge(edge: Edge, nodesById: Map<string, Node>): Edge {
  if (!isCodeManagedEdge(edge, (nodeId) => nodesById.get(nodeId))) {
    return edge;
  }

  return { ...edge, deletable: false, reconnectable: false };
}

/**
 * Drop nodes that repeat an id. Two nodes sharing an id make ReactFlow apply a
 * drag to both at once (they "move together"); this can happen after a layout
 * carries stale duplicates. Keeps the first occurrence.
 */
function dedupeNodes(nodes: Node[]): Node[] {
  const seen = new Set<string>();

  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);

    return true;
  });
}

/** Deterministic edge id matching its endpoints. */
function plainEdgeId(source: string, target: string): string {
  return `xy-edge__${source}-${target}`;
}

/**
 * Migrate legacy auto-redirected edges (agent→sandbox carrying `_original`) back into direct
 * agent→workspace edges, matching the explicit-wiring model.
 */
function unredirectEdge(edge: Edge): Edge {
  const data = (edge.data as Record<string, unknown> | undefined) ?? {};
  const original = data._original;
  if (typeof original !== "string") return edge;

  const nextData = { ...data };
  delete nextData._original;

  return {
    ...edge,
    id: plainEdgeId(edge.source, original),
    target: original,
    data: nextData,
  };
}

/** Whether an edge already connects the two nodes, in either direction. */
/** Drop duplicate edges by id and by node pair, keeping the first of each. Subagent links are
 * directional (A→B and B→A coexist), so they key by ordered pair; everything else by unordered. */
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

/**
 * Serialize a layout to the exact shape we persist, for change detection. Lets the DB-sync
 * effect skip the echo of our own save. Resetting state to raw DB objects drops measured
 * sizes and selection, which re-measures every node and flickers the whole canvas.
 */
function layoutSignature(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    n: nodes.map((n) => [n.id, n.type, n.position.x, n.position.y, n.data]),
    e: edges.map((e) => [e.id, e.source, e.target, e.animated ?? false]),
  });
}

/** Ignore global shortcuts while typing in editable controls. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName;

  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

/** Collapsed frame ids for one project and stage. Per browser, so a failed read is just "none". */
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
    // Storage blocked or full: the toggle still holds for this visit.
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
}: {
  projectId: Id<"projects">;
}): React.JSX.Element {
  const { stageId } = useStage();
  const stageArgs = stageId
    ? { projectId: projectId, stageId: stageId }
    : ("skip" as const);
  const canvasLayout = useQuery(api.canvas.getByProject, stageArgs);
  const mcpServers = useQuery(api.mcp.listByStage, stageArgs);
  const mcpServersByNode = useMemo(
    () => serversByNode(mcpServers ?? []),
    [mcpServers],
  );
  const machineConnections = useQuery(
    api.sandbox.machines.listForActiveOrg,
    stageArgs,
  );
  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Arrowheads are rendered per-edge inside each edge component (one shared geometry across
  // all edge kinds, recolorable on hover), so no markerEnd here.
  const defaultEdgeOptions = useMemo(
    () => ({
      style: {
        stroke: isDark ? AGENT_EDGE_STROKE.dark : AGENT_EDGE_STROKE.light,
        strokeWidth: 1.5,
      },
      // Never animated: ReactFlow's animated edges run a continuous dash
      // keyframe that repaints the canvas layer on every frame.
      animated: false,
    }),
    [isDark],
  );

  // Flat state, the shape that is saved. React Flow draws `framedGraph`.
  const [nodes, setNodes] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  // The canvas remounts per stage, so the key is fixed for this instance.
  const collapsedKey = `canvas-collapsed-frames:${projectId}:${stageId}`;
  const [collapsedFrames, setCollapsedFrames] = useState(() =>
    readCollapsedFrames(collapsedKey),
  );
  // The group under the card being dragged, and why it will not take it.
  const [drop, setDrop] = useState<CanvasDrop | null>(null);
  const [focusedFrameId, setFocusedFrameId] = useState<string | null>(null);
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  // What the right-clicked card offers; null on a frame or the empty canvas,
  // which get "Add to this group" and "Add service".
  const [nodeMenu, setNodeMenu] = useState<CanvasNodeMenuEntries | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedAt, setSelectedAt] = useState(0);
  const [saveState, setSaveState] = useState<CanvasSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped to make the DB-sync effect run again when no new layout arrived.
  const [resyncToken, setResyncToken] = useState(0);
  // The card the delete dialog is confirming. Kept after the dialog closes so
  // its name does not blank out mid fade-out.
  const [deleteNode, setDeleteNode] = useState<Node | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameNode, setRenameNode] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [agentCreatePosition, setAgentCreatePosition] =
    useState<FlowPosition | null>(null);
  const { screenToFlowPosition, setCenter, getZoom, fitView } = useReactFlow();
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
  // The last layout the database sent, for telling an edit's ref problems
  // from ones the saved graph already had.
  const savedLayoutRef = useRef(canvasLayout);

  // Clicking a chip opens it: the selected node, which `buildFramedGraph` draws
  // as a card in a card's slot while it is a chip in an open frame. Selecting
  // anything else closes it, so only ever one is open.
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

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    framedGraphRef.current = framedGraph;
  }, [nodes, edges, framedGraph]);

  /**
   * React Flow reports changes against the drawn graph. A drag moves frames
   * and their members; a measurement or selection never moves anything, and a
   * frame's own selection or size never reaches state.
   */
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

  /** Collapsing is a per-browser view choice: stored locally, never saved. */
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
    // Keep the cached layout in sync with the pending write so the post-save
    // snapshot matches what's on screen (local React state is already optimistic).
    localStore.setQuery(
      api.canvas.getByProject,
      { projectId: args.projectId, stageId: args.stageId },
      { nodes: args.nodes, edges: args.edges },
    );
  });
  const updateRuntimeRefs = useMutation(api.agent.config.updateRuntimeRefs);
  const updateSubagentRefs = useMutation(api.agent.config.updateSubagentRefs);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLocalChanges = useRef(false);
  // Bumped on every edit. A save that resolves against an older generation must
  // not clear the dirty flag. The sync effect would then overwrite the newer
  // local state with the snapshot that write was built from.
  const editGeneration = useRef(0);
  const lastRuntimeRefs = useRef(new Map<string, string>());
  const lastSubagentRefs = useRef(new Map<string, string>());

  /** Debounced save. Writes current local state to the database after 500ms of inactivity. */
  const scheduleSave = useCallback(() => {
    hasLocalChanges.current = true;
    editGeneration.current += 1;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      if (!stageId) return;
      const generation = editGeneration.current;
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      // The config API would refuse these refs after the layout had already
      // landed. Save nothing and put the last saved graph back instead.
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
      // The layout write is optimistic (withOptimisticUpdate above), so this
      // latency and its outcome are what a rollback rate is computed from.
      const startedAt = performance.now();
      // The layout write is optimistic; a reference write is not. Tracking them
      // apart keeps the rollback rate from counting ref failures as rollbacks.
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
          // The mutation may materialize runtime resources (assign fresh resourceIds), so
          // merge only changed node `data` back. Replacing whole node objects would drop
          // measured sizes and any drag started since the snapshot, the post-save flicker.
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

          // Both groups always run: awaiting them in sequence let one failed
          // runtime-ref write skip every subagent allow-list in the same save.
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
          // Clear the dirty flag only when no edit landed while this write was
          // in flight: clearing it after a stale success let the DB sync
          // overwrite the newer local state with no message.
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
          // A failed save hands the canvas back to the database: the pill says
          // what failed, and the next update replaces this graph. Holding the
          // dirty flag instead kept the sync off for the tab, so a later save
          // overwrote CLI deploys and other tabs. A newer edit keeps it.
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

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Sync nodes/edges from the database. Skip when local changes are pending or a drag is in
  // progress, and skip updates that already match local state (the echo of our own save).
  useEffect(() => {
    savedLayoutRef.current = canvasLayout;
    if (hasLocalChanges.current || isDraggingNode.current) return;

    if (canvasLayout) {
      // Strip persisted `animated: true` (legacy layouts). Animated edges run a
      // continuous dash keyframe. Normalized before the signature so the echo
      // check still matches local state; the next save persists the flag off.
      const persistedEdges = (canvasLayout.edges as Edge[]).map((edge) =>
        edge.animated ? { ...edge, animated: false } : edge,
      );
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
              .map(unredirectEdge)
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

      // The `fitView` prop only fires on mount, when nodes are still empty (the layout loads
      // async), so center the whole architecture once the first real layout arrives.
      if (!didInitialFit.current) {
        didInitialFit.current = true;
        if (canvasLayout.nodes.length > 0) fitView(FIT_VIEW_OPTIONS);
        // The cold-load milestone: navigation start to the first frame that
        // has the real architecture on it. LCP stops at the header, so this
        // is the number that tracks the whole auth-to-canvas chain.
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

  /**
   * Apply an edit to the flat graph and save it. Positions settle first, so a
   * frame an edit joins or leaves stays where it was drawn. The refs update
   * at once, so a second edit in the same event reads this one.
   */
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

  /** Deleting a bundle edge deletes every agent→member edge it stands for. */
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

  // A server gaining or changing its transport moves its node to another
  // frame. Settle positions as for an edit; the first load moves nothing,
  // since MCP nodes were not framed before it. Only a writer saves them: a
  // member's save is refused, so their tab settles the drawing alone.
  const lastMcpServers = useRef(mcpServers);
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

  // Route Delete key to the confirm dialog instead of immediate node deletion.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete") return;
      if (!selectedNode) return;
      if (isEditableTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      setDeleteNode(selectedNode);
      setDeleteOpen(true);
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNode]);

  // Re-center the focused node after the side panel finishes its width transition,
  // so it stays visually centered as the canvas shrinks or grows back.
  const lastFocusedNode = useRef<Node | null>(null);
  useEffect(() => {
    const node = selectedNode ?? lastFocusedNode.current;
    if (selectedNode) lastFocusedNode.current = selectedNode;
    if (!node) return;

    const id = window.setTimeout(() => {
      const width = node.measured?.width ?? node.width ?? 0;
      const height = node.measured?.height ?? node.height ?? 0;
      setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: getZoom(),
        duration: 200,
      });
      if (!selectedNode) lastFocusedNode.current = null;
    }, 220);

    return () => window.clearTimeout(id);
  }, [selectedNode, setCenter, getZoom]);

  /**
   * Global connection validator. Controls which connections ReactFlow highlights
   * and allows visually. Called before onConnect fires.
   */
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
  // The refusal notice keeps its own state (see CanvasRefusal); the canvas only
  // forwards the two events it cannot see from inside the flow.
  const refusalRef = useRef<CanvasRefusalHandle>(null);
  const clearRefusal = useCallback((): void => refusalRef.current?.clear(), []);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connection): void =>
      refusalRef.current?.onConnectEnd(event, connection),
    [],
  );

  const onConnect: OnConnect = useCallback(
    (params) => {
      // isValidConnection already enforced every rule, on this same edge.
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

  /** Compute the current viewport center in flow coordinates. */
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
      // Built once per right-click, not memoized on the graph: a memo would
      // rebuild the groups on every frame of a later drag.
      const menuNode = nodesRef.current.find((node) => node.id === nodeId);
      setNodeMenu(
        menuNode
          ? {
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
              links: nodeLinkActions(
                nodesRef.current,
                edgesRef.current,
                menuNode.id,
              ),
              mounts: workspaceMountTargets(
                nodesRef.current,
                edgesRef.current,
                menuNode.id,
              ),
              nodeId: menuNode.id,
            }
          : null,
      );
    },
    [clearRefusal, screenToFlowPosition, mcpServers],
  );

  /**
   * Position a manually added node: right under the cursor, stepped along the
   * dot grid only when that spot would cover another card. The right-click
   * point is consumed, so a later add that did not come from the context menu
   * lands in view rather than at a spot the user has since panned away from.
   */
  const getFreeAddPosition = useCallback((): FlowPosition => {
    const requested = lastRightClick.current ?? getViewportCenterPosition();
    lastRightClick.current = null;

    const graph = framedGraphRef.current;

    return findFreePosition(
      requested,
      graph ? boardRects(graph.nodes, graph.frames) : [],
    );
  }, [getViewportCenterPosition]);

  /**
   * Add a service node at a position and wire it: to `agentIds` when given,
   * else to the nearest agent. A frame's own menu passes the agents that own
   * it, which is what puts the new card in that frame rather than beside it.
   */
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

      // A sandbox any of them gets lands last in that agent's order.
      const nearest = findNearestAgentNode(nodesRef.current, position);
      const sources = autoWiredAgentIds(
        nodesRef.current,
        agentIds ?? (nearest ? [nearest.id] : []),
      );
      // Through `connectionEdge`, so the id carries the `xy-edge__` scheme the
      // drag path and both syncs mint. Its own format matched none of them,
      // which left the edge invisible to every check that reads an id prefix.
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
      // A card that joins a frame takes its next slot (see editGraph).
      editGraph((nodes, edges) => ({
        edges: [...edges, ...newEdges],
        nodes: [...nodes, newNode],
      }));
    },
    [getFreeAddPosition, editGraph],
  );

  /** Add a service to a frame, wired to every agent that owns it. */
  const addToFrame = useCallback(
    (frame: CanvasFrame) => {
      const template = NODE_TEMPLATES.find((item) => item.type === frame.kind);
      if (!template) return;
      addNode(template.type, template.label, undefined, frame.ownerIds);
    },
    [addNode],
  );

  /**
   * Re-lay the whole graph: each agent over a row of its services, shared
   * services between the agents that use them, unwired cards parked below.
   * Cards you dragged yourself move too. That is the point.
   */
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

  /**
   * Pull nodes out of their group, or put them back. Membership is derived, so
   * the flag on the node is the only record of it; the frame it leaves closes
   * over the gap and the card steps clear of it.
   */
  const setNodesUngrouped = useCallback(
    (nodeIds: readonly string[], ungrouped: boolean) => {
      editGraph((nodes, edges) => ({
        edges: edges,
        nodes: setUngrouped(nodes, nodeIds, ungrouped),
      }));
    },
    [editGraph],
  );

  /**
   * Block DB-sync resets while a drag is in flight so remote echoes can't clobber
   * it, and drop any refusal left over from a connection: the canvas shows one
   * notice, and this drag is about to own it.
   */
  const onNodeDragStart: OnNodeDrag = useCallback(() => {
    isDraggingNode.current = true;
    clearRefusal();
  }, [clearRefusal]);

  /**
   * Offer the group under the card being dragged. One card only: dragging a
   * selection is a move, not a gesture at a group. The target is worked out on
   * every move but written only when it changes, so a crossing re-renders the
   * canvas and a pixel does not.
   */
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

  /**
   * Settle a drop. A card let go over a group it can join is handed to the
   * group, which lays it out, and this stops there.
   *
   * Otherwise ReactFlow snaps the grabbed card to the dot grid and moves the
   * rest of the selection by the same offset, so nothing stops a card from
   * landing on top of another. Every dragged card steps to the nearest clear
   * spot, grabbed card first. A dragged frame stays where it snapped and its
   * members already moved with it.
   */
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, grabbed, dragged) => {
      isDraggingNode.current = false;
      const pending = dropRef.current;
      dropRef.current = null;
      setDrop(null);
      if (pending?.refusal === null && pending.nodeId === grabbed.id) {
        // The group takes it. `editGraph` settles the frame it joins around it,
        // so the card needs no clear spot of its own.
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
      // Dragged frames count where they were dropped, which the graph from the
      // last render does not know yet.
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

  /** Persist and close side panel when nodes are deleted via keyboard/context actions. */
  const onNodesDelete = useCallback(() => {
    setSelectedNode(null);
    scheduleSave();
  }, [scheduleSave]);

  /** Select a card and open its side panel; a click and the menu's Open both land here. */
  const openNode = useCallback((nodeId: string): void => {
    // The flat node, so the panel and the re-centre read absolute positions.
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    setFocusedFrameId(null);
    // Stamped here so the panel can report how long it took to appear. Most of
    // that window is its own dynamic import, not React.
    setSelectedAt(performance.now());
    setSelectedNode(node);
  }, []);

  /** Delete, from the card menu or the panel's Danger Zone: confirm over the canvas. */
  const requestNodeDelete = useCallback((nodeId: string): void => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    setDeleteNode(node);
    setDeleteOpen(true);
  }, []);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      clearRefusal();
      // A frame focuses its members like a selected node, with no panel and no Delete.
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
    setAgentCreatePosition(getFreeAddPosition());
    setSourcePickerOpen(true);
  }, [getFreeAddPosition]);
  const onCreateAgentFromPicker = useCallback(() => {
    onOpenCreateConfig(agentCreatePosition ?? getFreeAddPosition());
  }, [agentCreatePosition, getFreeAddPosition, onOpenCreateConfig]);

  /** Persist after edges are deleted. */
  const onEdgesDeleteHandler = useCallback(() => {
    scheduleSave();
  }, [scheduleSave]);

  /** Adds a skill node with the chosen source type baked into its config. */
  const onSkillSelect = useCallback(
    (source: "files" | "github" | "json") => {
      addNode("skill", "Skill", { config: { skillSource: source } });
    },
    [addNode],
  );

  /** Remove a node and its connected edges from the canvas. */
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

  /** Update a node's label in the canvas layout. */
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

  /** Update a node's persisted data payload. */
  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<BaseNodeData>) => {
      // A sandbox's provider or a workspace's storage picks its frame.
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

  /**
   * The rows a workspace's mount menu lists. Read from the refs on the open,
   * not memoized on the graph: a memo would rebuild them on every frame of a
   * drag, and hand every card a new context on the way.
   */
  const mountTargetsOf = useCallback(
    (workspaceId: string): WorkspaceMountTarget[] =>
      canWrite
        ? workspaceMountTargets(nodesRef.current, edgesRef.current, workspaceId)
        : [],
    [canWrite],
  );

  /** Mount a workspace where its menu says: from the edge's word or a card's menu. */
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

  // Structural signature (ignores positions) so infra badges only recompute on real graph
  // changes, not on every drag frame.
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
  const { infraAnalysis, orderNumbers, workspaceOnly } = useMemo(
    () => ({
      infraAnalysis: analyzeCanvasInfra(nodes, edges),
      orderNumbers: agreedSandboxOrderNumbers(nodes, edges),
      workspaceOnly: workspaceOnlySandboxIds(nodes, edges),
    }),
    // Recompute only when the structural signature changes (positions excluded).
    [infraKey],
  );
  const framesContext = useMemo(
    () => ({
      canWrite: canWrite,
      expandedMemberId: expandedMemberId,
      machineConnections: machineConnections,
      mcpServers: mcpServersByNode,
      mountTargetsOf: mountTargetsOf,
      onSetWorkspaceMount: setWorkspaceMountTarget,
      onToggleFrame: toggleFrame,
      sandboxOrderNumbers: orderNumbers,
      workspaceOnlySandboxIds: workspaceOnly,
    }),
    [
      canWrite,
      expandedMemberId,
      machineConnections,
      mcpServersByNode,
      mountTargetsOf,
      setWorkspaceMountTarget,
      toggleFrame,
      orderNumbers,
      workspaceOnly,
    ],
  );
  // The right-clicked frame, when a service added to it would land in it.
  const frameMenu = useMemo(() => {
    const frame = framedGraph.frames.find((item) => item.id === menuNodeId);

    return frame && acceptsNewMember(frame) ? frame : null;
  }, [menuNodeId, framedGraph]);

  // Commit-to-paint for a topology change: measured from the effect to the next
  // frame, so it covers ReactFlow's own layout, which is what scales with the
  // graph. Timing the analysis inside the memo would be an impure render.
  useEffect(() => {
    const startedAt = performance.now();
    const frame = requestAnimationFrame(() => {
      reportPerf("canvas.render", performance.now() - startedAt, {
        attributes: {
          nodes: nodesRef.current.length,
          edges: edgesRef.current.length,
        },
      });
    });

    return () => cancelAnimationFrame(frame);
    // Keyed on the structural signature: a drag must not produce a sample.
  }, [infraKey]);

  // C. Focus mode: selecting any node dims everything it does not connect TO. We follow edges
  // "outward" only. Default/subagent edges go by direction (source→target), so a resource never
  // lights up the agent wired INTO it; mount edges (workspace↔sandbox) flow both ways. Traversal
  // stops at any agent other than the selected one, so a subagent callee is highlighted but its
  // own resources (which belong to the callee) are not. A node wired to nothing highlights alone.
  // A focused frame starts from all of its members at once.
  const focusedFrameMembers = useMemo(
    () =>
      framedGraph.frames.find((frame) => frame.id === focusedFrameId)
        ?.memberIds ?? [],
    [framedGraph.frames, focusedFrameId],
  );
  // Joined, so the traversal below does not rerun each time a drag rebuilds the frames.
  const focusedFrameKey = focusedFrameMembers.join("\n");
  const focusedIds = useMemo(() => {
    const seeds = selectedNode
      ? [selectedNode.id]
      : focusedFrameKey
        ? focusedFrameKey.split("\n")
        : [];
    if (seeds.length === 0) return null;

    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Directed adjacency of "connects to": source→target for every edge, plus the reverse for
    // bidirectional mounts so selecting either a workspace or its sandbox reveals the other.
    const out = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      const list = out.get(a);
      if (list) list.push(b);
      else out.set(a, [b]);
    };
    for (const e of edges) {
      link(e.source, e.target);
      if (e.type === "mount") link(e.target, e.source);
    }

    const reachable = new Set<string>(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const current = queue.shift()!;
      // Don't expand out of a foreign agent (callee): its resources are its own, not the
      // selected node's. The selected node itself always expands.
      if (!seeds.includes(current) && byId.get(current)?.type === "agent") {
        continue;
      }
      for (const next of out.get(current) ?? []) {
        if (reachable.has(next)) continue;
        reachable.add(next);
        queue.push(next);
      }
    }

    return reachable;
    // BFS reads only node ids/types and edge endpoints, all captured by infraKey, so skip
    // the per-drag-frame recompute that `nodes` position churn would otherwise cause.
  }, [selectedNode, focusedFrameKey, infraKey]);

  // Focus runs on flat ids; a frame is lit when any member is.
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
    // Dedupe defensively so legacy data with a stale-id edge can't crash the renderer
    // with duplicate React keys before a reload rewrites it.
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
    <>
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
        <CanvasRefusal ref={refusalRef} getGraph={getConnectionGraph} />
        <CanvasDropPreview drop={drop} />
        {/* Save status lives away from the controls so it never crowds or
            reflows them; it clears itself once a save lands. */}
        <Panel position="bottom-left">
          <CanvasSaveStatus
            state={saveState}
            message={saveError}
            onRetry={scheduleSave}
          />
        </Panel>
      </ReactFlow>
    </>
  );

  // The provider spans the side panel too, so it reads the same traversal the
  // node cards do instead of walking the graph again for the selected node.
  const sidePanelWanted = useEverTrue(selectedNode !== null);
  const sourcePickerWanted = useEverTrue(sourcePickerOpen);
  const configDialogWanted = useEverTrue(configDialogOpen);
  const skillPickerWanted = useEverTrue(skillPickerOpen);

  return (
    <InfraAnalysisProvider value={infraAnalysis}>
      <div className="flex size-full overflow-hidden">
        <div
          ref={canvasContainerRef}
          className="relative h-full min-w-0 flex-1 overflow-hidden"
        >
          {/* The context menu wraps the flow even when the canvas is empty: an
            empty project is exactly when right-click-to-add needs to work. */}
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
                    </ContextMenuItem>
                  </Fragment>
                ))}
              </ContextMenuContent>
            )}
          </ContextMenu>

          {isEmpty && canWrite && (
            <EmptyCanvasGuide onCreateConfig={() => onOpenCreateConfig()} />
          )}
          {isEmpty && !canWrite && (
            <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
              No services yet. An org admin can add one.
            </p>
          )}
        </div>

        <div
          className={`h-full shrink-0 overflow-hidden transition-all duration-200 ease-out ${selectedNode ? "w-2/5" : "w-0"}`}
        >
          {sidePanelWanted && (
            <NodeSidePanel
              node={selectedNode}
              selectedAt={selectedAt}
              onClose={onPaneClick}
              onRequestDelete={requestNodeDelete}
              onUpdateNodeLabel={updateNodeLabel}
              onUpdateNodeData={updateNodeData}
            />
          )}
        </div>

        {deleteNode && (
          // Keyed on the card so the typed confirmation does not carry over
          // from the last card a delete was asked for.
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
            // Mounted only while a rename is asked for, so any close clears it.
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

/**
 * True from the first render in which `flag` was true. Mounts a lazy
 * component on first use and keeps it mounted, so its close animation and
 * state survive without loading its chunk before it is wanted.
 */
function useEverTrue(flag: boolean): boolean {
  const [seen, setSeen] = useState(flag);
  if (flag && !seen) setSeen(true);

  return seen || flag;
}
