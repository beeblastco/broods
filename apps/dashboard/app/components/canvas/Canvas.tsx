"use client";

/** Main canvas component that renders nodes and edges from the database. */
import { CanvasControls } from "@/app/components/canvas/CanvasControl";
import { DeletableEdge } from "@/app/components/canvas/DeletableEdge";
import { isCodeManagedEdgeId } from "@/app/components/canvas/edgeOwnership";
import { MountEdge } from "@/app/components/canvas/MountEdge";
import { SubagentEdge } from "@/app/components/canvas/SubagentEdge";
import { EmptyCanvasGuide } from "@/app/components/canvas/EmptyCanvasGuide";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { AgentNode } from "@/app/components/node/Agent";
import { DatabaseNode } from "@/app/components/node/Database";
import { SandboxNode } from "@/app/components/node/Sandbox";
import { SkillNode } from "@/app/components/node/Skill";
import { ToolNode } from "@/app/components/node/Tool";
import { WorkspaceNode } from "@/app/components/node/Workspace";
import { InfraAnalysisProvider } from "@/app/components/canvas/InfraAnalysisContext";
import {
  analyzeCanvasInfra,
  defaultRuntimeNodeData,
  deriveAgentRuntimeRefs,
  deriveSubagentRefs,
  serializeRuntimeRefs,
  serializeSubagentRefs,
} from "@/app/lib/canvasRuntimeRefs";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/app/components/ui/context-menu";
import { api } from "@filthy-panty/convex/_generated/api";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import {
  addEdge,
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
  type Node,
  type NodeMouseHandler,
  type OnConnect,
  type OnNodeDrag,
} from "@xyflow/react";
import { useMutation, useQuery } from "convex/react";
import { Bot, Box, Database, FolderOpen, Sparkles, Wrench } from "lucide-react";
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

// Defer interaction-only components to reduce initial bundle size.
const NodeSidePanel = dynamic(
  () =>
    import("@/app/components/NodeSidePanel").then((mod) => mod.NodeSidePanel),
  { loading: () => <div className="h-full w-full" /> },
);
const AgentSourcePickerDialog = dynamic(() =>
  import("@/app/components/AgentSourcePickerDialog").then(
    (mod) => mod.AgentSourcePickerDialog,
  ),
);
const CreateAgentConfigDialog = dynamic(() =>
  import("@/app/components/CreateAgentConfigDialog").then(
    (mod) => mod.CreateAgentConfigDialog,
  ),
);
const ToolSourcePickerDialog = dynamic(() =>
  import("@/app/components/ToolSourcePickerDialog").then(
    (mod) => mod.ToolSourcePickerDialog,
  ),
);
const SkillSourcePickerDialog = dynamic(() =>
  import("@/app/components/SkillSourcePickerDialog").then(
    (mod) => mod.SkillSourcePickerDialog,
  ),
);

const nodeTypes = {
  agent: AgentNode,
  database: DatabaseNode,
  sandbox: SandboxNode,
  workspace: WorkspaceNode,
  tool: ToolNode,
  skill: SkillNode,
};

const edgeTypes = {
  default: DeletableEdge,
  mount: MountEdge,
  subagent: SubagentEdge,
};

const NODE_TEMPLATES = [
  { type: "agent", label: "Agent", icon: Bot },
  { type: "database", label: "Session", icon: Database },
  { type: "sandbox", label: "Sandbox", icon: Box },
  { type: "workspace", label: "Workspace", icon: FolderOpen },
  { type: "skill", label: "Skill", icon: Sparkles },
  { type: "tool", label: "Tool", icon: Wrench },
] as const;

/** Static ReactFlow options hoisted outside components to avoid object churn on re-renders. */
const FIT_VIEW_OPTIONS = { maxZoom: 1.5, padding: 1 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;
type FlowPosition = { x: number; y: number };

function hydrateEncodedHandleEdge(
  edge: Edge,
  prefix: "mount:" | "subagent:",
  type: "mount" | "subagent",
): Edge {
  if (!edge.id.startsWith(prefix)) return edge;
  const payload = edge.id.slice(prefix.length);
  const parts = payload.split("-");
  // parts: [source, sourceHandle, target, targetHandle] — works for numeric
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
  const sourceManagedBy = (nodesById.get(edge.source)?.data as
    | { managedBy?: string }
    | undefined)?.managedBy;
  const targetManagedBy = (nodesById.get(edge.target)?.data as
    | { managedBy?: string }
    | undefined)?.managedBy;
  if (
    !isCodeManagedEdgeId(edge.id) &&
    !(sourceManagedBy === "cli" && targetManagedBy === "cli")
  ) {
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
function hasEdgeBetween(edges: Edge[], a: string, b: string): boolean {
  return edges.some(
    (e) =>
      (e.source === a && e.target === b) || (e.source === b && e.target === a),
  );
}

/** Whether a connection uses a side handle (left/right) — i.e. a mount or subagent link. */
function isSideConnection(c: {
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): boolean {
  return (
    c.sourceHandle === "left" ||
    c.sourceHandle === "right" ||
    c.targetHandle === "left" ||
    c.targetHandle === "right"
  );
}

/**
 * Whether an agent already has a direct (non-mount) sandbox edge — its single default sandbox
 * (config.sandbox). `exceptSandboxId` ignores one sandbox so a re-check of the same pair passes.
 */
function agentHasDirectSandbox(
  edges: Edge[],
  nodes: Node[],
  agentId: string,
  exceptSandboxId?: string,
): boolean {
  return edges.some((e) => {
    if (e.type === "mount") return false;
    const other =
      e.source === agentId ? e.target : e.target === agentId ? e.source : null;
    if (!other || other === exceptSandboxId) return false;

    return nodes.find((n) => n.id === other)?.type === "sandbox";
  });
}

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
 * effect skip the echo of our own save — resetting state to raw DB objects drops measured
 * sizes and selection, which re-measures every node and flickers the whole canvas.
 */
function layoutSignature(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    n: nodes.map((n) => [n.id, n.type, n.position.x, n.position.y, n.data]),
    e: edges.map((e) => [e.id, e.source, e.target, e.animated ?? false]),
  });
}

/**
 * Focus-mode dim caches, keyed by source object identity. Reusing the dimmed clone keeps
 * unchanged elements referentially stable across drag frames — fresh clones each frame
 * would re-render every dimmed node/edge at 60fps. WeakMap entries follow their keys' GC.
 */
const dimmedNodeCache = new WeakMap<Node, Node>();
const dimmedEdgeCache = new WeakMap<Edge, Edge>();

/** Ignore global shortcuts while typing in editable controls. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

/** Find the nearest agent node to a given flow position. */
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

/** Inner canvas that consumes ReactFlow context. */
function CanvasInner({ projectId }: { projectId: Id<"projects"> }) {
  const { environmentId } = useEnvironment();
  const canvasLayout = useQuery(
    api.canvas.getByProject,
    environmentId
      ? { projectId: projectId, environmentId: environmentId }
      : "skip",
  );
  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Arrowheads are rendered per-edge inside each edge component (one shared geometry across
  // all edge kinds, recolorable on hover), so no markerEnd here.
  const defaultEdgeOptions = useMemo(
    () => ({
      style: {
        stroke: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)",
        strokeWidth: 1.5,
      },
      animated: true,
    }),
    [isDark],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [deleteRequestToken, setDeleteRequestToken] = useState(0);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [agentCreatePosition, setAgentCreatePosition] =
    useState<FlowPosition | null>(null);
  const { screenToFlowPosition, setCenter, getZoom, fitView } = useReactFlow();
  const nextId = useRef(1);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const lastRightClick = useRef<FlowPosition | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const isDraggingNode = useRef(false);
  const didInitialFit = useRef(false);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);
  const saveLayoutMutation = useMutation(
    api.canvas.saveLayout,
  ).withOptimisticUpdate((localStore, args) => {
    // Keep the cached layout in sync with the pending write so the post-save
    // snapshot matches what's on screen (local React state is already optimistic).
    localStore.setQuery(
      api.canvas.getByProject,
      { projectId: args.projectId, environmentId: args.environmentId },
      { nodes: args.nodes, edges: args.edges },
    );
  });
  const updateRuntimeRefs = useMutation(api.agentConfig.updateRuntimeRefs);
  const updateSubagentRefs = useMutation(api.agentConfig.updateSubagentRefs);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLocalChanges = useRef(false);
  const lastRuntimeRefs = useRef(new Map<string, string>());
  const lastSubagentRefs = useRef(new Map<string, string>());

  /** Debounced save — writes current local state to the database after 500ms of inactivity. */
  const scheduleSave = useCallback(() => {
    hasLocalChanges.current = true;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      if (!environmentId) return;
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      saveLayoutMutation({
        projectId: projectId,
        environmentId: environmentId,
        nodes: currentNodes.map((n) => ({
          id: n.id,
          type: n.type as
            | "agent"
            | "database"
            | "sandbox"
            | "workspace"
            | "tool"
            | "skill",
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
          // measured sizes and any drag started since the snapshot — the post-save flicker.
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

          const refs = deriveAgentRuntimeRefs(persistedNodes, currentEdges);
          await Promise.all(
            refs.map(async (ref) => {
              const serialized = serializeRuntimeRefs(ref);
              if (lastRuntimeRefs.current.get(ref.configId) === serialized) {
                return;
              }
              lastRuntimeRefs.current.set(ref.configId, serialized);
              await updateRuntimeRefs({
                configId: ref.configId,
                sandbox: ref.sandbox ?? null,
                workspaces: ref.workspaces.length > 0 ? ref.workspaces : null,
              });
            }),
          );

          // Persist agent→agent subagent allow-lists from the canvas edges.
          const subagentRefs = deriveSubagentRefs(persistedNodes, currentEdges);
          await Promise.all(
            subagentRefs.map(async (ref) => {
              const serialized = serializeSubagentRefs(ref);
              if (lastSubagentRefs.current.get(ref.configId) === serialized) {
                return;
              }
              lastSubagentRefs.current.set(ref.configId, serialized);
              await updateSubagentRefs({
                configId: ref.configId,
                calleeConfigIds: ref.calleeConfigIds,
              });
            }),
          );
        })
        .finally(() => {
          hasLocalChanges.current = false;
        });
    }, 500);
  }, [
    environmentId,
    projectId,
    saveLayoutMutation,
    setNodes,
    updateRuntimeRefs,
    updateSubagentRefs,
  ]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Sync nodes/edges from the database — skip when local changes are pending or a drag is in
  // progress, and skip updates that already match local state (the echo of our own save).
  useEffect(() => {
    if (hasLocalChanges.current || isDraggingNode.current) return;

    if (canvasLayout) {
      const incoming = layoutSignature(
        canvasLayout.nodes as Node[],
        canvasLayout.edges as Edge[],
      );
      if (incoming !== layoutSignature(nodesRef.current, edgesRef.current)) {
        const nextNodes = dedupeNodes(canvasLayout.nodes as Node[]);
        const nodesById = new Map(nextNodes.map((node) => [node.id, node]));
        setNodes(nextNodes);
        setEdges(
          dedupeEdges(
            (canvasLayout.edges as Edge[])
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
      // async) — so center the whole architecture once the first real layout arrives.
      if (!didInitialFit.current) {
        didInitialFit.current = true;
        if (canvasLayout.nodes.length > 0) fitView(FIT_VIEW_OPTIONS);
      }
    } else {
      setNodes([]);
      setEdges([]);
      nextId.current = 1;
    }
  }, [canvasLayout, setNodes, setEdges, fitView]);

  // Route Delete key to the side-panel confirmation flow instead of immediate node deletion.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete") return;
      if (!selectedNode) return;
      if (isEditableTarget(event.target)) return;

      event.preventDefault();
      event.stopPropagation();
      setDeleteRequestToken((token) => token + 1);
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
   * Global connection validator — controls which connections ReactFlow highlights
   * and allows visually. Called before onConnect fires.
   */
  const isValidConnection = useCallback((connection: Connection | Edge) => {
    if (connection.source === connection.target) return false;

    const srcNode = nodesRef.current.find((n) => n.id === connection.source);
    const tgtNode = nodesRef.current.find((n) => n.id === connection.target);
    const isMountPair =
      (srcNode?.type === "workspace" || srcNode?.type === "sandbox") &&
      (tgtNode?.type === "workspace" || tgtNode?.type === "sandbox");
    const isAgentPair = srcNode?.type === "agent" && tgtNode?.type === "agent";

    // Subagent links are directional (A→B and B→A coexist), so dedupe by direction; every other
    // pair allows a single edge either way.
    const duplicate = isAgentPair
      ? edgesRef.current.some(
          (e) =>
            e.source === connection.source && e.target === connection.target,
        )
      : hasEdgeBetween(edgesRef.current, connection.source, connection.target);
    if (duplicate) return false;

    // Side handles serve mounts (workspace↔sandbox) and subagent links (agent↔agent) only;
    // those pairs must use the sides on BOTH ends, never the top/bottom handles — a half-side
    // edge would encode a null handle into its id and fail to hydrate after a reload.
    if (isSideConnection(connection)) {
      const sourceIsSide =
        connection.sourceHandle === "left" || connection.sourceHandle === "right";
      const targetIsSide =
        connection.targetHandle === "left" || connection.targetHandle === "right";

      return sourceIsSide && targetIsSide && (isMountPair || isAgentPair);
    }
    if (isMountPair || isAgentPair) return false;

    // D — an agent has a single default sandbox (config.sandbox); block a 2nd direct one.
    const agentNode =
      srcNode?.type === "agent"
        ? srcNode
        : tgtNode?.type === "agent"
          ? tgtNode
          : null;
    const sandboxNode =
      srcNode?.type === "sandbox"
        ? srcNode
        : tgtNode?.type === "sandbox"
          ? tgtNode
          : null;
    if (
      agentNode &&
      sandboxNode &&
      agentHasDirectSandbox(
        edgesRef.current,
        nodesRef.current,
        agentNode.id,
        sandboxNode.id,
      )
    ) {
      return false;
    }

    return true;
  }, []);

  const onConnect: OnConnect = useCallback(
    (params) => {
      // isValidConnection already enforced every rule; build the edge and add it. Side-handle
      // info is encoded in the id (mount/subagent) so it survives the DB round-trip — the
      // saved layout only keeps id/source/target/animated.
      let edge: Edge | Connection = params;
      if (isSideConnection(params)) {
        const isAgentPair =
          nodesRef.current.find((n) => n.id === params.source)?.type ===
          "agent";
        const kind = isAgentPair ? "subagent" : "mount";
        edge = {
          ...params,
          id: `${kind}:${params.source}-${params.sourceHandle}-${params.target}-${params.targetHandle}`,
          type: kind,
          animated: false,
        };
      }

      setEdges((eds) => addEdge(edge, eds));
      scheduleSave();
    },
    [setEdges, scheduleSave],
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
    (event: React.MouseEvent) => {
      lastRightClick.current = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
    },
    [screenToFlowPosition],
  );

  /** Add a service node at a position and auto-connect to the nearest agent. */
  const addNode = useCallback(
    (type: string, label: string, extraData?: Partial<BaseNodeData>) => {
      const position = lastRightClick.current ?? getViewportCenterPosition();
      const id = String(nextId.current++);
      const nodeLabel = `${label} ${id}`;

      const newNode: Node = {
        id: id,
        type: type,
        position: position,
        data: { ...defaultRuntimeNodeData(type, nodeLabel, id), ...extraData },
      };
      setNodes((nds) => [...nds, newNode]);

      // Auto-connect to nearest agent — unless it would wire a 2nd default sandbox.
      const nearest = findNearestAgentNode(nodesRef.current, position);
      const wouldDoubleSandbox =
        type === "sandbox" && nearest
          ? agentHasDirectSandbox(
              edgesRef.current,
              nodesRef.current,
              nearest.id,
            )
          : false;
      if (nearest && !wouldDoubleSandbox) {
        const newEdge: Edge = {
          id: `e${nearest.id}-${id}`,
          source: nearest.id,
          target: id,
        };
        setEdges((eds) => [...eds, newEdge]);
      }

      scheduleSave();
    },
    [getViewportCenterPosition, setNodes, setEdges, scheduleSave],
  );

  /** Block DB-sync resets while a drag is in flight so remote echoes can't clobber it. */
  const onNodeDragStart: OnNodeDrag = useCallback(() => {
    isDraggingNode.current = true;
  }, []);

  /** Save after a node drag completes. */
  const onNodeDragStop: OnNodeDrag = useCallback(() => {
    isDraggingNode.current = false;
    scheduleSave();
  }, [scheduleSave]);

  /** Persist and close side panel when nodes are deleted via keyboard/context actions. */
  const onNodesDelete = useCallback(() => {
    setSelectedNode(null);
    scheduleSave();
  }, [scheduleSave]);

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => setSelectedNode(null), []);
  const onOpenCreateConfig = useCallback(
    (position?: FlowPosition) => {
      setAgentCreatePosition(position ?? getViewportCenterPosition());
      setConfigDialogOpen(true);
    },
    [getViewportCenterPosition],
  );
  const onConfigDialogOpenChange = useCallback((open: boolean) => {
    setConfigDialogOpen(open);
    if (!open) setAgentCreatePosition(null);
  }, []);
  const onOpenSourcePicker = useCallback(() => {
    setAgentCreatePosition(
      lastRightClick.current ?? getViewportCenterPosition(),
    );
    setSourcePickerOpen(true);
  }, [getViewportCenterPosition]);
  const onCreateAgentFromPicker = useCallback(() => {
    onOpenCreateConfig(agentCreatePosition ?? getViewportCenterPosition());
  }, [agentCreatePosition, getViewportCenterPosition, onOpenCreateConfig]);

  /** Persist after edges are deleted. */
  const onEdgesDeleteHandler = useCallback(() => {
    scheduleSave();
  }, [scheduleSave]);

  /** Stable handler for tool source picker selection. */
  const onToolSelect = useCallback(() => {
    // TODO: handle "docker" and "upload" sources with dedicated flows
    addNode("tool", "Tool");
  }, [addNode]);

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
      setEdges((eds) =>
        eds.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setSelectedNode(null);
      scheduleSave();
    },
    [setNodes, setEdges, scheduleSave],
  );

  /** Update a node's label in the canvas layout. */
  const updateNodeLabel = useCallback(
    (nodeId: string, label: string) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, label: label } } : n,
        ),
      );
      setSelectedNode((current) =>
        current?.id === nodeId
          ? { ...current, data: { ...current.data, label: label } }
          : current,
      );
      scheduleSave();
    },
    [setNodes, scheduleSave],
  );

  /** Update a node's persisted data payload. */
  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<BaseNodeData>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      );
      setSelectedNode((current) =>
        current?.id === nodeId
          ? { ...current, data: { ...current.data, ...patch } }
          : current,
      );
      scheduleSave();
    },
    [setNodes, scheduleSave],
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
          return [n.id, n.type, d?.resourceId, d?.label, d?.mountName];
        }),
        e: edges.map((e) => [e.source, e.target, e.type]),
      }),
    [nodes, edges],
  );
  const infraAnalysis = useMemo(
    () => analyzeCanvasInfra(nodes, edges),
    // Recompute only when the structural signature changes (positions excluded).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [infraKey],
  );

  // C — focus mode: selecting any node dims everything it does not connect TO. We follow edges
  // "outward" only — default/subagent edges by direction (source→target), so a resource never
  // lights up the agent wired INTO it; mount edges (workspace↔sandbox) flow both ways. Traversal
  // stops at any agent other than the selected one, so a subagent callee is highlighted but its
  // own resources (which belong to the callee) are not. A node wired to nothing highlights alone.
  const focusedIds = useMemo(() => {
    if (!selectedNode) return null;

    const byId = new Map(nodes.map((n) => [n.id, n]));

    // Directed adjacency of "connects to": source→target for every edge, plus the reverse for
    // bidirectional mounts so selecting either a workspace or its sandbox reveals the other.
    const out = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = out.get(a);
      if (list) list.push(b);
      else out.set(a, [b]);
    };
    for (const e of edges) {
      link(e.source, e.target);
      if (e.type === "mount") link(e.target, e.source);
    }

    const reachable = new Set<string>([selectedNode.id]);
    const queue = [selectedNode.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      // Don't expand out of a foreign agent (callee): its resources are its own, not the
      // selected node's. The selected node itself always expands.
      if (current !== selectedNode.id && byId.get(current)?.type === "agent") {
        continue;
      }
      for (const next of out.get(current) ?? []) {
        if (reachable.has(next)) continue;
        reachable.add(next);
        queue.push(next);
      }
    }

    return reachable;
    // BFS reads only node ids/types and edge endpoints — all captured by infraKey — so skip
    // the per-drag-frame recompute that `nodes` position churn would otherwise cause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, infraKey]);

  const displayNodes = useMemo(() => {
    if (!focusedIds) return nodes;

    return nodes.map((n) => {
      if (focusedIds.has(n.id)) return n;
      let dimmed = dimmedNodeCache.get(n);
      if (!dimmed) {
        dimmed = { ...n, style: { ...n.style, opacity: 0.25 } };
        dimmedNodeCache.set(n, dimmed);
      }

      return dimmed;
    });
  }, [nodes, focusedIds]);

  const displayEdges = useMemo(() => {
    // Dedupe defensively so legacy data with a stale-id edge can't crash the renderer
    // with duplicate React keys before a reload rewrites it.
    const base = dedupeEdges(edges);
    if (!focusedIds) return base;

    return base.map((e) => {
      if (focusedIds.has(e.source) && focusedIds.has(e.target)) return e;
      let dimmed = dimmedEdgeCache.get(e);
      if (!dimmed) {
        dimmed = { ...e, style: { ...e.style, opacity: 0.12 } };
        dimmedEdgeCache.set(e, dimmed);
      }

      return dimmed;
    });
  }, [edges, focusedIds]);

  const flow = (
    <InfraAnalysisProvider value={infraAnalysis}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDeleteHandler}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        maxZoom={1.5}
        deleteKeyCode={null}
        colorMode={isDark ? "dark" : "light"}
        proOptions={PRO_OPTIONS}
        defaultEdgeOptions={defaultEdgeOptions}
      >
        <Background
          gap={24}
          size={1.5}
          color={isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"}
        />
        <Panel position="top-left">
          <CanvasControls />
        </Panel>
      </ReactFlow>
    </InfraAnalysisProvider>
  );

  return (
    <div className="flex size-full overflow-hidden">
      <div
        ref={canvasContainerRef}
        className="relative h-full min-w-0 flex-1 overflow-hidden"
      >
        {isEmpty ? (
          <div className="size-full">{flow}</div>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="size-full" onContextMenu={onContextMenu}>
                {flow}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48 rounded-lg border border-border bg-card/80 p-1 backdrop-blur-md">
              <ContextMenuLabel className="text-xs tracking-wider text-muted-foreground pt-2!">
                Add service
              </ContextMenuLabel>
              {NODE_TEMPLATES.map(({ type, label, icon: Icon }, index) => (
                <Fragment key={type}>
                  {index === NODE_TEMPLATES.length - 1 && (
                    <ContextMenuSeparator />
                  )}
                  <ContextMenuItem
                    onClick={() =>
                      type === "agent"
                        ? onOpenSourcePicker()
                        : type === "tool"
                          ? setToolPickerOpen(true)
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
          </ContextMenu>
        )}

        {isEmpty && (
          <EmptyCanvasGuide onCreateConfig={() => onOpenCreateConfig()} />
        )}
      </div>

      <div
        className={`h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${selectedNode ? "w-2/5" : "w-0"}`}
      >
        <NodeSidePanel
          node={selectedNode}
          deleteRequestToken={deleteRequestToken}
          onClose={onPaneClick}
          onRemoveNode={removeNode}
          onUpdateNodeLabel={updateNodeLabel}
          onUpdateNodeData={updateNodeData}
        />
      </div>

      <AgentSourcePickerDialog
        open={sourcePickerOpen}
        onOpenChange={setSourcePickerOpen}
        onCreateNew={onCreateAgentFromPicker}
      />

      <CreateAgentConfigDialog
        projectId={projectId}
        environmentId={environmentId}
        open={configDialogOpen}
        onOpenChange={onConfigDialogOpenChange}
        initialCanvasPosition={agentCreatePosition}
      />

      <ToolSourcePickerDialog
        open={toolPickerOpen}
        onOpenChange={setToolPickerOpen}
        onSelect={onToolSelect}
      />

      <SkillSourcePickerDialog
        open={skillPickerOpen}
        onOpenChange={setSkillPickerOpen}
        onSelect={onSkillSelect}
      />
    </div>
  );
}

/** Main canvas wrapped with ReactFlowProvider. */
export function Canvas({ projectId }: { projectId: Id<"projects"> }) {
  return (
    <ReactFlowProvider>
      <CanvasInner projectId={projectId} />
    </ReactFlowProvider>
  );
}
