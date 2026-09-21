/**
 * Where a dragged card would land if it were let go now, and the sentence that
 * says why a group will not take it.
 *
 * Membership is derived, so a drop invents none of it. It writes only what the
 * derivation reads: an edge to each agent that owns the group, the `ungrouped`
 * flag the card was pulled out with, and the slot the chips sit in. A group that
 * orders itself keeps its own order, so the slot on offer there is the one the
 * rules give rather than the one under the cursor: see `ordersItself`.
 *
 * A drop is refused for anything the layout write would refuse it for, so that a
 * card never lands and then springs back when the save runs.
 *
 * Pure and exported on purpose, like `canvasConnections.ts`: the `/ui-gallery`
 * drag fixture drives this exact function, so a spec drags a real card across a
 * real frame and gets the real answer.
 */
import {
  connectionEdge,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import { connectionRefusal } from "@/app/lib/canvasConnections";
import {
  cardLabel,
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
  framesOf,
  frameSize,
  memberSlotHeight,
  type CanvasFrame,
  type FrameKind,
} from "@broods/convex/model/canvasFrames";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutPosition,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import type { Edge, Node } from "@xyflow/react";

/** The box every card has, the one the dragged card is judged by. */
const CARD_SIZE = { height: NODE_HEIGHT, width: NODE_WIDTH };

/** How near a card's box comes to a group's, in flow pixels, before it is offered it. */
const DROP_RANGE = 40;

/** How a refusal names the group a card is over. */
const KIND_NOUN: Record<FrameKind, string> = {
  mcp: "MCP",
  sandbox: "sandbox",
  workspace: "workspace",
};

/** How a refusal names the card being dragged. */
const KIND_SUBJECT: Record<FrameKind, string> = {
  mcp: "An MCP server",
  sandbox: "A sandbox",
  workspace: "A workspace",
};

/** Where a dragged card would land, and what stands in the way of it landing. */
export type CanvasDrop = {
  /** The frame it would join, or null while its group is still one loose card. */
  frameId: string | null;
  /**
   * The id of the group it lands in, which a stored slot names so that it stops
   * counting if the card is later wired somewhere else. Empty while the drop is
   * only being tried out, before that group is known.
   */
  groupId: string;
  /** What splits groups of this kind: where a sandbox runs, an MCP transport. */
  key: string;
  /** Which of the three framed kinds the group holds. */
  kind: FrameKind;
  /** The group's name, as the preview box and the refusal say it. */
  label: string;
  /** The members it would sit among, in slot order, itself left out. */
  memberIds: string[];
  /** The card being dragged. */
  nodeId: string;
  /** Every agent the group answers to, which the drop wires the card to. */
  ownerIds: string[];
  /** Why the canvas will not take it, or null when it will. */
  refusal: string | null;
  /** Its place among the members, 0 first. */
  slot: number;
};

/** A group a dragged card came near: a drawn frame, or a card that is a group on its own. */
type DropCandidate = Omit<
  CanvasDrop,
  "groupId" | "nodeId" | "refusal" | "slot"
> & {
  /** Collapsed to one card, so it shows no slots to choose between. */
  collapsed: boolean;
  /** The box on screen the card is measured against. */
  rect: LayoutRect;
};

/**
 * The graph after the drop: the card wired to every agent the group answers to,
 * back in its group, and in the slot it was dropped on. Only for a drop whose
 * `refusal` is null. It writes what the drop says without judging it again, and
 * leaves a sandbox order code owns alone.
 *
 * With an empty `groupId` it writes no cosmetic slot, which is how the rules try
 * a drop out before they know which group it lands in. Membership is the same
 * either way: a slot only sorts a group, it never decides who is in it.
 */
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

/**
 * The group the dragged card would join at this position, or null when none is
 * near enough to reach for it. A drawn frame that will not take the card says so;
 * two loose cards that do not belong together stay quiet, because cards pass each
 * other all the time and only a frame is aimed at.
 */
export function canvasDropTarget(params: {
  /** Frames drawn as one card, by id, which take a card but offer it no slot. */
  collapsedFrames: ReadonlySet<string>;
  /** The chip drawn as a card, which moves the slots under it down. */
  expandedMemberId: string | null;
  graph: FlatGraph;
  nodeId: string;
  /** Where the card is now, mid-drag, not where it was stored. */
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

  // The nearest group that will take the card wins, so a card it overlaps but
  // has nothing to do with cannot talk over the frame behind it. When none will,
  // a frame still answers: it is a box you aim at. Two cards drifting past each
  // other are not a gesture, so a drop that cannot happen says nothing.
  return (
    offers.find((offer) => offer.refusal === null) ??
    offers.find((offer) => offer.frameId !== null) ??
    null
  );
}

/**
 * The slot the drawn graph should open for this drop, or null when none does.
 * Only a frame opens one, and only for a drop it will take: a refused drop is
 * outlined instead, and two loose cards have no frame to grow yet.
 */
export function pendingDropOf(drop: CanvasDrop | null): PendingDrop | null {
  return drop !== null && drop.refusal === null && drop.frameId !== null
    ? { frameId: drop.frameId, slot: drop.slot }
    : null;
}

/** Whether two drop offers say the same thing, so the canvas can keep the first. */
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

/** Why the group will not take the card, before its effect is worked out, or null. */
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

/** Every group on screen a card could be dropped on, with the box it is drawn in. */
function candidatesFor(
  graph: FlatGraph,
  nodeId: string,
  expandedMemberId: string | null,
  collapsedFrames: ReadonlySet<string>,
): DropCandidate[] {
  const servers = serversByNode(graph.mcpServers ?? []);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const frames = framesOf(
    deriveGroups(graph.nodes, graph.edges, graph.mcpServers),
  );
  const framed = new Set(frames.flatMap((frame) => frame.memberIds));
  const drawn = new Set(frames.map((frame) => frame.id));
  // Groups as they would be with nothing pulled out, so a card holding the flag
  // still says which group it came from.
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
            // Measured by the box it draws, which while collapsed is one card.
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
      // A card pulled out of a frame that is still drawn rejoins through the
      // frame, not through the card: dropping onto the card would pull it back
      // in as well, which is not the two-card group the preview would promise.
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

/** The group a node lands in once the drop is applied, or null when it lands in none. */
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

/** What one group near the card offers it: the slot it opens, or the reason it will not. */
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
    // Not known until the drop has been tried: see `applyCanvasDrop`.
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
  // Exactly this group, plus the card. A bigger one means the drop would move
  // members the preview never named, so it is not the drop that was offered.
  const joined =
    landed !== null &&
    landed.memberIds.length === target.memberIds.length + 1 &&
    target.memberIds.every((id) => landed.memberIds.includes(id));
  // The layout write refuses a graph that breaks a runtime rule, so a drop that
  // would break one is refused here rather than saved and rolled back. Reordering
  // an agent's sandboxes can: only its first backs a workspace.
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
    // The slot shown is the one the card really takes. A group that orders itself
    // keeps the place its own rules give; every other group takes the cursor's.
    slot:
      ordersItself(target) && landed !== null
        ? landed.memberIds.indexOf(dragged.id)
        : cursorSlot,
  };
}

/**
 * Nodes with the drop's order written where the derivation reads it: a sandbox
 * group rewrites its agents' `sandboxes`, and every group whose order is only
 * cosmetic writes each member's own slot. A group that orders itself stores
 * nothing, and an agent code manages keeps the order its project gives it.
 */
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

/**
 * Whether the group's own order means more than looks, so a drop stores no slot
 * for it: a sandbox group is its agents' `sandboxes`, which the drop rewrites
 * instead, and a machine MCP group follows the computers its servers run on, so
 * that its runs-on edges never cross.
 */
function ordersItself(group: Pick<CanvasDrop, "key" | "kind">): boolean {
  return (
    group.kind === "sandbox" ||
    (group.kind === "mcp" && group.key === "machine")
  );
}

/** Gap between two boxes, 0 where they overlap. */
function rectGap(a: LayoutRect, b: LayoutRect): number {
  const x = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const y = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);

  return Math.hypot(x, y);
}

/** The slot under the cursor: one per member whose middle the card has passed. */
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
  // No chips on screen to aim between, so it joins at the end.
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

/** Why the card would group on its own instead of joining the one it was dropped on. */
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

  return `${cardLabel(dragged)} answers to ${others.join(" and ")} as well, so it groups on its own.`;
}

/** The agents a node already has an edge to, whichever end of it the node is. */
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
