/**
 * Edits on the flat canvas graph that frames care about: where cards go when
 * an edit changes which frame they belong to and what a card's menu offers.
 * Pure, so each rule is unit-tested here.
 */
import {
  connectionEdge,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import {
  deriveGroups,
  facingHandles,
  type StageMcpServer,
} from "@/app/lib/canvasFrameNodes";
import {
  defaultRuntimeNodeData,
  runtimeRefsProblems,
  type RuntimeRefsProblem,
} from "@/app/lib/canvasRuntimeRefs";
import {
  agentSandboxOrder,
  edgeKind,
  frameGroupOf,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  workspaceSandboxIds,
  type CanvasFrame,
  type FrameSize,
} from "@broods/convex/model/canvasFrames";
import {
  findFreePosition,
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutEdge,
  type LayoutNode,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import type { Edge, Node, XYPosition } from "@xyflow/react";

/** The box every card has, whatever it holds, for the free-spot search. */
export const CARD_SIZE: FrameSize = { height: NODE_HEIGHT, width: NODE_WIDTH };

/** A frame waiting on a free spot, and the origin it would rather keep. */
type DeferredFrame = { desired: XYPosition; frame: CanvasFrame };

/** A flat graph as one edit sees it, with the server list its frames depend on. */
export type FlatGraph = {
  edges: Edge[];
  /** Undefined while loading; MCP nodes are not framed until then. */
  mcpServers: readonly StageMcpServer[] | undefined;
  nodes: Node[];
};

/**
 * What a right-click offers for the group a node is in, or the one it was
 * pulled out of, and the nodes each entry flags. Every entry writes the same
 * `data.ungrouped` flag: the first two set it, `rejoin` clears it.
 */
export type FrameGroupAction = {
  frameLabel: string;
  kind: "pull-out" | "rejoin" | "ungroup-all";
  nodeIds: string[];
};

/**
 * What a right-click on a card can do to its links: one `unlink` per stored
 * edge, named after the card at the other end and locked when code owns the
 * edge, plus make default for a sandbox under each agent that wires it.
 * `agentLabel` names the agent only when several do, so the entries differ.
 * Make default carries why it is refused, when the config API would refuse it.
 */
export type NodeLinkAction =
  | {
      kind: "make-default";
      agentId: string;
      agentLabel: string | null;
      disabledReason: string | null;
    }
  | {
      kind: "unlink";
      edgeId: string;
      label: string;
      locked: boolean;
      /** A workspace↔sandbox mount reads "Unmount". */
      mount: boolean;
      /** The linked card's node type, which picks the row's icon. */
      otherType: Node["type"];
    };

/**
 * One row of a workspace's mount menu. `default` drops its mount edges so the
 * agent's first sandbox applies, `sandbox` draws a mount edge, and `readonly`
 * sets the flag that emits a `sandbox: null` ref: an absent mount edge already
 * means inherit, so the graph has no other way to ask for no sandbox at all.
 */
export type WorkspaceMountTarget =
  | { current: boolean; kind: "default" }
  | { current: boolean; kind: "readonly" }
  | { current: boolean; kind: "sandbox"; label: string; sandboxId: string };

/**
 * Whether a service added to a frame would land in it. A fresh node carries
 * the group key its defaults give it, so a cloud sandbox frame and an S3
 * workspace frame take one and the machine, hosted and url frames do not:
 * nothing a new node holds puts it in those.
 */
export function acceptsNewMember(frame: CanvasFrame): boolean {
  const group = frameGroupOf(
    {
      data: defaultRuntimeNodeData(frame.kind, "", "new"),
      id: "new",
      type: frame.kind,
    },
    new Map(),
  );

  return group !== null && group.key === frame.key;
}

/**
 * The agents a card added from the canvas menu wires itself to, out of the
 * ones on offer: a frame's owners, or the nearest agent. A `cli` or `api`
 * agent reads its wiring from the manifest it was deployed from, never from
 * the canvas, so an edge drawn to it here would show a link the agent does not
 * have. The card lands unwired instead.
 */
export function autoWiredAgentIds(
  nodes: readonly Node[],
  agentIds: readonly string[],
): string[] {
  return agentIds.filter(
    (id) =>
      !isCodeManagedOwner(nodes.find((node) => node.id === id)?.data.managedBy),
  );
}

/**
 * The boxes top-level display nodes cover, for the free-spot search. A frame
 * counts at its expanded size even while collapsed, so nothing lands where it
 * opens.
 */
export function boardRects(
  displayNodes: readonly Node[],
  frames: readonly CanvasFrame[],
): LayoutRect[] {
  const sizes = new Map(frames.map((frame) => [frame.id, frameSize(frame)]));

  return displayNodes
    .filter((node) => node.parentId === undefined)
    .map((node) => ({
      ...node.position,
      ...(sizes.get(node.id) ?? CARD_SIZE),
    }));
}

/** The name a card shows, as menus and refusal sentences say it. */
export function cardLabel(node: Node): string {
  return typeof node.data.label === "string" ? node.data.label : node.id;
}

/**
 * Group entries for a node's context menu: a member can leave its frame or
 * dissolve it, a node that was pulled out can go back. Rejoining takes the
 * other pulled-out nodes of the same group with it when this node alone would
 * not re-form a frame, so the entry always visibly does something.
 */
export function frameGroupActions(
  graph: FlatGraph,
  nodeId: string,
): FrameGroupAction[] {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const frame = framedGroups(graph, graph.nodes).find((item) =>
    item.memberIds.includes(nodeId),
  );
  if (frame) {
    return [
      { frameLabel: frame.label, kind: "pull-out", nodeIds: [nodeId] },
      {
        frameLabel: frame.label,
        kind: "ungroup-all",
        nodeIds: [...frame.memberIds],
      },
    ];
  }
  if (node.data.ungrouped !== true) return [];
  const restored = setUngrouped(
    graph.nodes,
    graph.nodes.map((item) => item.id),
    false,
  );
  const home = framedGroups(graph, restored).find((item) =>
    item.memberIds.includes(nodeId),
  );
  if (!home) return [];
  const alone = framedGroups(
    graph,
    setUngrouped(graph.nodes, [nodeId], false),
  ).some((item) => item.memberIds.includes(nodeId));
  const pulled = new Set(
    graph.nodes
      .filter((item) => item.data.ungrouped === true)
      .map((item) => item.id),
  );

  return [
    {
      frameLabel: home.label,
      kind: "rejoin",
      nodeIds: alone ? [nodeId] : home.memberIds.filter((id) => pulled.has(id)),
    },
  ];
}

/**
 * The frames `nodes` draw with this graph's edges and server list, for the
 * group entries: the same derivation the canvas draws from.
 */
export function framedGroups(
  graph: FlatGraph,
  nodes: readonly Node[],
): CanvasFrame[] {
  return framesOf(deriveGroups(nodes, graph.edges, graph.mcpServers));
}

/**
 * The first runtime-ref problem `after` has that `before` did not, or null.
 * Used to refuse an edit up front: a problem the graph already had is not
 * this edit's to block. Problems match on resource ids, so renaming a sandbox
 * or a workspace does not make an old problem look new.
 */
export function introducedRuntimeRefsProblem(
  before: Pick<FlatGraph, "edges" | "nodes">,
  after: Pick<FlatGraph, "edges" | "nodes">,
): RuntimeRefsProblem | null {
  const keyOf = (problem: RuntimeRefsProblem): string =>
    `${problem.agentId}\n${problem.workspaceId}\n${problem.sandboxId}`;
  const existing = new Set(
    runtimeRefsProblems(before.nodes, before.edges).map(keyOf),
  );

  return (
    runtimeRefsProblems(after.nodes, after.edges).find(
      (problem) => !existing.has(keyOf(problem)),
    ) ?? null
  );
}

/** Put a sandbox first in an agent's stored `sandboxOrder`, keeping the rest in order. */
export function makeDefaultSandbox<T extends LayoutNode>(
  nodes: readonly T[],
  edges: readonly LayoutEdge[],
  agentId: string,
  sandboxId: string,
): T[] {
  return nodes.map((node) => {
    if (node.id !== agentId) return node;
    const rest = agentSandboxOrder(node, nodes, edges).filter(
      (id) => id !== sandboxId,
    );

    return {
      ...node,
      data: { ...node.data, sandboxOrder: [sandboxId, ...rest] },
    };
  });
}

/**
 * A card's link entries for its context menu, one per stored edge it has. Make
 * default only where the sandbox is not already first and the agent is not
 * code-managed (code owns its order), and disabled where the new order breaks
 * the runtime rules. An edge code owns is listed locked, so the menu shows the
 * link and that it cannot be cut here.
 */
export function nodeLinkActions(
  nodes: Node[],
  edges: Edge[],
  nodeId: string,
): NodeLinkAction[] {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const linked = edges.flatMap((edge) => {
    const otherId =
      edge.source === nodeId
        ? edge.target
        : edge.target === nodeId
          ? edge.source
          : null;
    const other = otherId === null ? undefined : byId.get(otherId);

    return other ? [{ edge: edge, other: other }] : [];
  });
  const wiringAgents = linked.filter(
    ({ edge, other }) => edgeKind(edge) === "default" && other.type === "agent",
  ).length;

  return linked.flatMap(({ edge, other }): NodeLinkAction[] => {
    const actions: NodeLinkAction[] = [];
    if (
      node.type === "sandbox" &&
      other.type === "agent" &&
      edgeKind(edge) === "default" &&
      !isCodeManagedOwner(other.data.managedBy) &&
      agentSandboxOrder(other, nodes, edges)[0] !== nodeId
    ) {
      const problem = introducedRuntimeRefsProblem(
        { edges: edges, nodes: nodes },
        {
          edges: edges,
          nodes: makeDefaultSandbox(nodes, edges, other.id, nodeId),
        },
      );
      actions.push({
        agentId: other.id,
        agentLabel: wiringAgents > 1 ? cardLabel(other) : null,
        disabledReason: problem
          ? `${problem.workspaceName} is mounted on ${problem.sandboxLabel}`
          : null,
        kind: "make-default",
      });
    }
    actions.push({
      edgeId: edge.id,
      kind: "unlink",
      // Subagent links run both ways between two agents, so the row says which.
      label:
        edgeKind(edge) !== "subagent"
          ? cardLabel(other)
          : edge.source === nodeId
            ? `calls ${cardLabel(other)}`
            : `called by ${cardLabel(other)}`,
      locked: edge.deletable === false,
      mount: edgeKind(edge) === "mount",
      otherType: other.type,
    });

    return actions;
  });
}

/**
 * Flat nodes of `next` with positions settled after an edit that may change
 * frame membership. A frame that was already drawn keeps its origin whoever
 * joins or leaves it, and its members take its slots. One that gained a member
 * steps clear when its taller box would cover a neighbour: a frame is drawn
 * from its members, so nothing else moves out of its way. A frame that grows
 * out of a lone card starts where that card stood, so the card's box becomes
 * the frame's; any other new frame starts where its members stand. Either steps
 * clear of every other box. A frame that shrinks to one member hands its
 * origin to that member's card. Any other card that left all frames steps
 * clear of the frame it sat in. Frames whose members did not change, and
 * cards that stay cards, are not moved. Returns `next.nodes` itself when
 * nothing moves.
 */
export function reconcileFramePositions(
  previous: FlatGraph,
  next: FlatGraph,
): Node[] {
  const groupsBefore = deriveGroups(
    previous.nodes,
    previous.edges,
    previous.mcpServers,
  );
  const groupsAfter = deriveGroups(next.nodes, next.edges, next.mcpServers);
  const before = framesOf(groupsBefore);
  const after = framesOf(groupsAfter);
  const groupBefore = new Map(groupsBefore.map((group) => [group.id, group]));
  const groupAfter = new Map(groupsAfter.map((group) => [group.id, group]));
  const beforeById = new Map(before.map((frame) => [frame.id, frame]));
  const framedBefore = new Set(before.flatMap((frame) => frame.memberIds));
  const framedAfter = new Set(after.flatMap((frame) => frame.memberIds));
  const previousPositions = positionsById(previous.nodes);
  const nextPositions = positionsById(next.nodes);
  const moves = new Map<string, XYPosition>();
  const occupied: LayoutRect[] = [];
  const place = (
    frame: CanvasFrame,
    origin: XYPosition,
    move: boolean,
  ): void => {
    if (move) {
      for (const [id, position] of frameMemberPositions(origin, frame)) {
        moves.set(id, position);
      }
    }
    occupied.push({ ...origin, ...frameSize(frame) });
  };

  // A frame that has to search for its spot is placed after every box that
  // holds one: the frames nobody joined or left, then the cards in no frame on
  // either side.
  const grown: DeferredFrame[] = [];
  const fresh: DeferredFrame[] = [];
  for (const frame of after) {
    const kept = beforeById.get(frame.id);
    if (!kept) {
      const [card] = groupBefore.get(frame.id)?.memberIds ?? [];
      const cardPosition =
        card === undefined ? undefined : previousPositions.get(card);
      fresh.push({
        desired: cardPosition ?? originOf(frame.memberIds, nextPositions),
        frame: frame,
      });
      continue;
    }
    const origin = originOf(kept.memberIds, previousPositions);
    // A taller box can cover a neighbour. One that shrank still fits where it
    // stood, and searching would snap it to the grid off a spot nothing wants.
    if (frameSize(frame).height > frameSize(kept).height) {
      grown.push({ desired: origin, frame: frame });
      continue;
    }
    const unchanged = kept.memberIds.join("\n") === frame.memberIds.join("\n");
    place(frame, origin, !unchanged);
  }
  for (const node of next.nodes) {
    if (framedBefore.has(node.id) || framedAfter.has(node.id)) continue;
    occupied.push({ ...node.position, ...CARD_SIZE });
  }
  // A frame that was already drawn has first claim on the space it wants.
  for (const { desired, frame } of [...grown, ...fresh]) {
    place(frame, findFreeBox(desired, frameSize(frame), occupied), true);
  }
  // A frame's last member first, so it keeps the frame's spot over a leaver.
  const leavers = next.nodes
    .filter((node) => framedBefore.has(node.id) && !framedAfter.has(node.id))
    .map((node) => {
      const dissolved = before.find(
        (frame) =>
          frame.memberIds.includes(node.id) &&
          groupAfter.get(frame.id)?.memberIds[0] === node.id,
      );

      return {
        desired: dissolved
          ? originOf(dissolved.memberIds, previousPositions)
          : node.position,
        first: dissolved !== undefined,
        node: node,
      };
    })
    .sort((a, b) => Number(b.first) - Number(a.first));
  for (const { desired, node } of leavers) {
    const position = findFreePosition(desired, occupied);
    moves.set(node.id, position);
    occupied.push({ ...position, ...CARD_SIZE });
  }

  let moved = false;
  const nodes = next.nodes.map((node) => {
    const position = moves.get(node.id);
    if (
      !position ||
      (position.x === node.position.x && position.y === node.position.y)
    ) {
      return node;
    }
    moved = true;

    return { ...node, position: position };
  });

  return moved ? nodes : next.nodes;
}

/**
 * `nodes` with `data.ungrouped` set or cleared on `ids`. The flag is the one
 * stored thing about a group: a node carrying it joins none, so it draws as a
 * card until it is cleared again.
 */
export function setUngrouped<T extends LayoutNode>(
  nodes: readonly T[],
  ids: readonly string[],
  ungrouped: boolean,
): T[] {
  const targets = new Set(ids);

  return nodes.map((node): T => {
    if (!targets.has(node.id) || (node.data.ungrouped === true) === ungrouped) {
      return node;
    }
    if (ungrouped) {
      return { ...node, data: { ...node.data, ungrouped: true } };
    }
    const { ungrouped: _flag, ...data } = node.data;

    return { ...node, data: data };
  });
}

/**
 * The graph with a workspace mounted where `target` says: its own mount edges
 * dropped, one drawn again for a sandbox, and `readOnly` tracking the
 * no-sandbox row. Mount edges other workspaces hold are left alone.
 */
export function setWorkspaceMount(
  graph: FlatGraph,
  workspaceId: string,
  target: WorkspaceMountTarget,
): { edges: Edge[]; nodes: Node[] } {
  const kept = graph.edges.filter(
    (edge) =>
      edgeKind(edge) !== "mount" ||
      (edge.source !== workspaceId && edge.target !== workspaceId),
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const sandbox =
    target.kind === "sandbox" ? byId.get(target.sandboxId) : undefined;

  return {
    edges:
      sandbox === undefined
        ? kept
        : [
            ...kept,
            connectionEdge(
              {
                source: workspaceId,
                target: sandbox.id,
                ...facingHandles(byId.get(workspaceId), sandbox),
              },
              false,
            ),
          ],
    nodes: graph.nodes.map((node) =>
      node.id === workspaceId
        ? {
            ...node,
            data: { ...node.data, readOnly: target.kind === "readonly" },
          }
        : node,
    ),
  };
}

/**
 * The rows a workspace's mount menu lists, with the one it is on now marked:
 * the agent default where an agent wires it, every sandbox it could mount on,
 * and no sandbox at all. Empty for anything but a workspace the canvas owns,
 * since a code-managed ref is re-synced from the project it was deployed from.
 * Machine sandboxes are left out, because the config API refuses a workspace
 * mounted on one.
 */
export function workspaceMountTargets(
  nodes: readonly Node[],
  edges: readonly Edge[],
  workspaceId: string,
): WorkspaceMountTarget[] {
  const workspace = nodes.find((node) => node.id === workspaceId);
  if (
    workspace?.type !== "workspace" ||
    isCodeManagedOwner(workspace.data.managedBy)
  ) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = workspaceSandboxIds(nodes, edges).get(workspaceId);
  const mounted = new Set(
    state?.kind === "override" ? state.sandboxIds : undefined,
  );
  const wiresAgent = edges.some((edge) => {
    const otherId =
      edge.source === workspaceId
        ? edge.target
        : edge.target === workspaceId
          ? edge.source
          : null;

    return otherId !== null && byId.get(otherId)?.type === "agent";
  });
  const targets: WorkspaceMountTarget[] = [];
  if (wiresAgent) {
    targets.push({ current: state?.kind === "inherited", kind: "default" });
  }
  for (const node of nodes) {
    const config = (node.data as BaseNodeData).config;
    if (node.type !== "sandbox" || config?.provider === "machine") continue;
    targets.push({
      current: mounted.has(node.id),
      kind: "sandbox",
      label: cardLabel(node),
      sandboxId: node.id,
    });
  }
  targets.push({ current: state?.kind === "readonly", kind: "readonly" });

  return targets;
}

/**
 * Nearest grid point where a box of `size` clears every occupied box.
 * `findFreePosition` places a card, so each occupied box grows up and left by
 * how much bigger this box is than a card: a card clears the grown box exactly
 * when this box clears the original.
 */
function findFreeBox(
  desired: XYPosition,
  size: FrameSize,
  occupied: readonly LayoutRect[],
): XYPosition {
  const extraWidth = size.width - NODE_WIDTH;
  const extraHeight = size.height - NODE_HEIGHT;

  return findFreePosition(
    desired,
    occupied.map((box) => ({
      height: box.height + extraHeight,
      width: box.width + extraWidth,
      x: box.x - extraWidth,
      y: box.y - extraHeight,
    })),
  );
}

/** A frame's origin read from its members' positions in `positions`. */
function originOf(
  memberIds: readonly string[],
  positions: ReadonlyMap<string, XYPosition>,
): XYPosition {
  return frameOriginOf(memberIds.flatMap((id) => positions.get(id) ?? []));
}

function positionsById(nodes: readonly Node[]): Map<string, XYPosition> {
  return new Map(nodes.map((node) => [node.id, node.position]));
}
