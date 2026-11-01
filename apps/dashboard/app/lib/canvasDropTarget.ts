import {
  connectionEdge,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import { connectionRefusal } from "@/app/lib/canvasConnections";
import {
  CARD_SIZE,
  cardLabel,
  framedGroups,
  introducedRuntimeRefsProblem,
  setUngrouped,
  type FlatGraph,
} from "@/app/lib/canvasFrameEdits";
import { runtimeRefsProblemText } from "@/app/lib/canvasRuntimeRefs";
import {
  COLLAPSED_FRAME_HEIGHT,
  deriveGroups,
  serversByNode,
  type PendingDrop,
} from "@/app/lib/canvasFrameNodes";
import {
  agentOwners,
  agentSandboxOrder,
  frameGroupOf,
  frameMemberPositions,
  frameOriginOf,
  frameSize,
  memberSlotHeight,
  type CanvasFrame,
  type FrameKind,
} from "@broods/convex/model/canvasFrames";
import {
  NODE_WIDTH,
  type LayoutPosition,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import type { Edge, Node } from "@xyflow/react";

const DROP_RANGE = 40;

const KIND_NOUN: Record<FrameKind, string> = {
  mcp: "MCP",
  sandbox: "sandbox",
  workspace: "workspace",
};

const KIND_SUBJECT: Record<FrameKind, string> = {
  mcp: "An MCP server",
  sandbox: "A sandbox",
  workspace: "A workspace",
};

export type CanvasDrop = {
  frameId: string | null;
  /** Empty while the drop is only tried out, before its group is known. */
  groupId: string;
  key: string;
  kind: FrameKind;
  label: string;
  /** In slot order, the dragged card left out. */
  memberIds: string[];
  nodeId: string;
  ownerIds: string[];
  refusal: string | null;
  slot: number;
};

type DropCandidate = Omit<
  CanvasDrop,
  "groupId" | "nodeId" | "refusal" | "slot"
> & {
  collapsed: boolean;
  rect: LayoutRect;
};

// Only for an unrefused drop. An empty groupId (a trial) writes no cosmetic slot.
export function applyCanvasDrop(
  graph: FlatGraph,
  drop: CanvasDrop,
): { edges: Edge[]; nodes: Node[] } {
  const wired = wiredAgents(graph.edges, drop.nodeId);
  const edges: Edge[] = [
    ...graph.edges,
    ...drop.ownerIds
      .filter((ownerId) => !wired.has(ownerId))
      .map((ownerId) =>
        connectionEdge(
          {
            source: ownerId,
            sourceHandle: null,
            target: drop.nodeId,
            targetHandle: null,
          },
          true,
        ),
      ),
  ];
  const order = [...drop.memberIds];
  order.splice(drop.slot, 0, drop.nodeId);
  const joined = setUngrouped(
    graph.nodes,
    [drop.nodeId, ...drop.memberIds],
    false,
  );

  return { edges: edges, nodes: orderedNodes(joined, edges, drop, order) };
}

export function canvasDropTarget(params: {
  collapsedFrames: ReadonlySet<string>;
  expandedMemberId: string | null;
  graph: FlatGraph;
  nodeId: string;
  position: LayoutPosition;
}): CanvasDrop | null {
  const { collapsedFrames, expandedMemberId, graph, nodeId, position } = params;
  const dragged = graph.nodes.find((node) => node.id === nodeId);
  const group = dragged
    ? frameGroupOf(dragged, serversByNode(graph.mcpServers ?? []))
    : null;
  if (!dragged || !group) return null;
  const box: LayoutRect = { ...position, ...CARD_SIZE };
  const offers = candidatesFor(graph, nodeId, expandedMemberId, collapsedFrames)
    .map((candidate) => ({
      candidate: candidate,
      gap: rectGap(box, candidate.rect),
    }))
    .filter((near) => near.gap <= DROP_RANGE)
    .sort((a, b) => a.gap - b.gap)
    .map((near) =>
      offerOf(graph, dragged, near.candidate, {
        centerY: position.y + CARD_SIZE.height / 2,
        expandedMemberId: expandedMemberId,
        group: group,
      }),
    );

  // The nearest group that takes the card wins; failing that, a refusing frame answers.
  // Loose cards drifting past each other are not a gesture, so they stay quiet.
  return (
    offers.find((offer) => offer.refusal === null) ??
    offers.find((offer) => offer.frameId !== null) ??
    null
  );
}

export function pendingDropOf(drop: CanvasDrop | null): PendingDrop | null {
  return drop !== null && drop.refusal === null && drop.frameId !== null
    ? { frameId: drop.frameId, slot: drop.slot }
    : null;
}

export function sameCanvasDrop(
  a: CanvasDrop | null,
  b: CanvasDrop | null,
): boolean {
  if (a === null || b === null) return a === b;

  return (
    a.frameId === b.frameId &&
    a.nodeId === b.nodeId &&
    a.refusal === b.refusal &&
    a.slot === b.slot &&
    a.memberIds.length === b.memberIds.length &&
    a.memberIds.every((id, index) => id === b.memberIds[index])
  );
}

function blockingReason(
  graph: FlatGraph,
  dragged: Node,
  target: DropCandidate,
  group: { key: string; kind: FrameKind; label: string },
): string | null {
  if (group.kind !== target.kind) {
    return `${KIND_SUBJECT[group.kind]} joins no ${KIND_NOUN[target.kind]} group.`;
  }
  if (group.key !== target.key) {
    return `${cardLabel(dragged)} belongs to ${group.label}, not ${target.label}.`;
  }
  if (target.ownerIds.length === 0) {
    const first = graph.nodes.find((node) => node.id === target.memberIds[0]);

    return `Wire ${first ? cardLabel(first) : target.label} to an agent first.`;
  }
  const wired = wiredAgents(graph.edges, dragged.id);

  return (
    target.ownerIds
      .filter((ownerId) => !wired.has(ownerId))
      .map((ownerId) =>
        connectionRefusal(graph, {
          source: ownerId,
          sourceHandle: null,
          target: dragged.id,
          targetHandle: null,
        }),
      )
      .find((reason) => reason !== null) ?? null
  );
}

function candidatesFor(
  graph: FlatGraph,
  nodeId: string,
  expandedMemberId: string | null,
  collapsedFrames: ReadonlySet<string>,
): DropCandidate[] {
  const servers = serversByNode(graph.mcpServers ?? []);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const frames = framedGroups(graph, graph.nodes);
  const framed = new Set(frames.flatMap((frame) => frame.memberIds));
  const drawn = new Set(frames.map((frame) => frame.id));
  // Derived as if nothing were pulled out, so an ungrouped card still knows its home.
  const homes = deriveGroups(
    setUngrouped(
      graph.nodes,
      graph.nodes.map((node) => node.id),
      false,
    ),
    graph.edges,
    graph.mcpServers,
  );
  const owners = agentOwners(graph.nodes, graph.edges);

  return [
    ...frames
      .filter((frame) => !frame.memberIds.includes(nodeId))
      .map((frame): DropCandidate => {
        const positions = frame.memberIds.flatMap(
          (id) => byId.get(id)?.position ?? [],
        );
        const collapsed = collapsedFrames.has(frame.id);

        return {
          collapsed: collapsed,
          frameId: frame.id,
          key: frame.key,
          kind: frame.kind,
          label: frame.label,
          memberIds: [...frame.memberIds],
          ownerIds: [...frame.ownerIds],
          rect: {
            ...frameOriginOf(positions),
            ...(collapsed
              ? { height: COLLAPSED_FRAME_HEIGHT, width: NODE_WIDTH }
              : frameSize(frame, expandedMemberId ?? undefined)),
          },
        };
      }),
    ...graph.nodes.flatMap((node): DropCandidate[] => {
      if (node.id === nodeId || framed.has(node.id)) return [];
      const group = frameGroupOf(node, servers);
      if (!group) return [];
      const home = homes.find((item) => item.memberIds.includes(node.id));
      // A card pulled out of a drawn frame rejoins through the frame: dropping onto
      // it would pull it back in too, not the two-card group the preview promises.
      if (home && drawn.has(home.id)) return [];

      return [
        {
          collapsed: false,
          frameId: null,
          key: group.key,
          kind: group.kind,
          label: group.label,
          memberIds: [node.id],
          ownerIds: home
            ? [...home.ownerIds]
            : [...(owners.get(node.id) ?? [])],
          rect: { ...node.position, ...CARD_SIZE },
        },
      ];
    }),
  ];
}

function groupOf(
  after: { edges: Edge[]; nodes: Node[] },
  mcpServers: FlatGraph["mcpServers"],
  nodeId: string,
): CanvasFrame | null {
  return (
    deriveGroups(after.nodes, after.edges, mcpServers).find((group) =>
      group.memberIds.includes(nodeId),
    ) ?? null
  );
}

function offerOf(
  graph: FlatGraph,
  dragged: Node,
  target: DropCandidate,
  context: {
    centerY: number;
    expandedMemberId: string | null;
    group: { key: string; kind: FrameKind; label: string };
  },
): CanvasDrop {
  const cursorSlot = slotFor(
    graph,
    target,
    context.centerY,
    context.expandedMemberId,
  );
  const drop: CanvasDrop = {
    frameId: target.frameId,
    groupId: "",
    key: target.key,
    kind: target.kind,
    label: target.label,
    memberIds: target.memberIds,
    nodeId: dragged.id,
    ownerIds: target.ownerIds,
    refusal: null,
    slot: cursorSlot,
  };
  const blocked = blockingReason(graph, dragged, target, context.group);
  const after = blocked === null ? applyCanvasDrop(graph, drop) : null;
  const landed = after ? groupOf(after, graph.mcpServers, dragged.id) : null;
  // Exactly this group plus the card: a bigger one moves members the preview never named.
  const joined =
    landed !== null &&
    landed.memberIds.length === target.memberIds.length + 1 &&
    target.memberIds.every((id) => landed.memberIds.includes(id));
  // Refuse what the layout write would, so a card never lands and then springs back.
  const problem =
    after !== null && joined
      ? introducedRuntimeRefsProblem(
          { edges: graph.edges, nodes: graph.nodes },
          { edges: after.edges, nodes: after.nodes },
        )
      : null;

  return {
    ...drop,
    groupId: landed?.id ?? "",
    refusal:
      blocked ??
      (problem !== null ? runtimeRefsProblemText(problem) : null) ??
      (after !== null && !joined ? splitReason(graph, dragged, target) : null),
    slot:
      ordersItself(target) && landed !== null
        ? landed.memberIds.indexOf(dragged.id)
        : cursorSlot,
  };
}

function orderedNodes(
  nodes: readonly Node[],
  edges: readonly Edge[],
  drop: CanvasDrop,
  order: readonly string[],
): Node[] {
  if (drop.kind !== "sandbox") {
    if (ordersItself(drop) || drop.groupId === "") return [...nodes];
    const slots = new Map(order.map((id, index) => [id, index]));

    return nodes.map((node) => {
      const slot = slots.get(node.id);

      return slot === undefined
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              frameSlot: { group: drop.groupId, slot: slot },
            },
          };
    });
  }
  const previous = order[drop.slot - 1];
  const next = order[drop.slot + 1];

  return nodes.map((node) => {
    if (
      !drop.ownerIds.includes(node.id) ||
      isCodeManagedOwner(node.data.managedBy)
    ) {
      return node;
    }
    const rest = agentSandboxOrder(node, nodes, edges).filter(
      (id) => id !== drop.nodeId,
    );
    const after = previous === undefined ? -1 : rest.indexOf(previous);
    const before = next === undefined ? -1 : rest.indexOf(next);
    const at = after >= 0 ? after + 1 : before >= 0 ? before : rest.length;
    const sandboxOrder = [...rest];
    sandboxOrder.splice(at, 0, drop.nodeId);

    return { ...node, data: { ...node.data, sandboxOrder: sandboxOrder } };
  });
}

// No cosmetic slot: a sandbox group's order is its agents' `sandboxOrder`, and a
// machine MCP group follows its servers' computers so runs-on edges never cross.
function ordersItself(group: Pick<CanvasDrop, "key" | "kind">): boolean {
  return (
    group.kind === "sandbox" ||
    (group.kind === "mcp" && group.key === "machine")
  );
}

function rectGap(a: LayoutRect, b: LayoutRect): number {
  const x = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const y = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);

  return Math.hypot(x, y);
}

function slotFor(
  graph: FlatGraph,
  target: DropCandidate,
  centerY: number,
  expandedMemberId: string | null,
): number {
  if (target.frameId === null) {
    const partner = graph.nodes.find((node) => node.id === target.memberIds[0]);

    return centerY < (partner?.position.y ?? 0) + CARD_SIZE.height / 2 ? 0 : 1;
  }
  if (target.collapsed) return target.memberIds.length;
  const expanded = expandedMemberId ?? undefined;
  const positions = frameMemberPositions(
    target.rect,
    { kind: target.kind, memberIds: target.memberIds },
    expanded,
  );

  return [...positions].filter(
    ([id, slot]) => centerY >= slot.y + memberSlotHeight(id, expanded) / 2,
  ).length;
}

function splitReason(
  graph: FlatGraph,
  dragged: Node,
  target: DropCandidate,
): string {
  const owners = agentOwners(graph.nodes, graph.edges).get(dragged.id);
  const others = [...(owners ?? [])]
    .filter((ownerId) => !target.ownerIds.includes(ownerId))
    .flatMap((ownerId) => {
      const agent = graph.nodes.find((node) => node.id === ownerId);

      return agent ? [cardLabel(agent)] : [];
    })
    .sort();
  if (others.length === 0) {
    return `${cardLabel(dragged)} does not join ${target.label}.`;
  }

  const named =
    others.length > 2
      ? `${others.slice(0, 2).join(", ")} and ${others.length - 2} more`
      : others.join(" and ");

  return `${cardLabel(dragged)} answers to ${named} as well, so it groups on its own.`;
}

function wiredAgents(edges: readonly Edge[], nodeId: string): Set<string> {
  return new Set(
    edges.flatMap((edge) =>
      edge.source === nodeId
        ? [edge.target]
        : edge.target === nodeId
          ? [edge.source]
          : [],
    ),
  );
}
