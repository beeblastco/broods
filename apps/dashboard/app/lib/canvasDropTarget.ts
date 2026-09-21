/**
 * Where a dragged card would land if it were let go now, and the sentence that
 * says why a group will not take it.
 *
 * Membership is derived, so a drop invents none of it. It writes only what the
 * derivation reads: an edge to each agent that owns the group, the `ungrouped`
 * flag the card was pulled out with, and the slot the chips sit in. A sandbox
 * group is ordered by its agents' `sandboxes`, the list the "1 · default" badge
 * counts, so where code owns that list the slot on offer is the one the rules
 * give rather than the one under the cursor.
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
  setUngrouped,
  type FlatGraph,
} from "@/app/lib/canvasFrameEdits";
import {
  COLLAPSED_FRAME_HEIGHT,
  deriveGroups,
  serversByNode,
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
type DropCandidate = Omit<CanvasDrop, "nodeId" | "refusal" | "slot"> & {
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
  // Groups as they would be with nothing pulled out, so a card holding the flag
  // still offers the group it came from.
  const homes = deriveGroups(
    setUngrouped(
      graph.nodes,
      graph.nodes.map((node) => node.id),
      false,
    ),
    graph.edges,
    graph.mcpServers,
  );
  const frames = framesOf(
    deriveGroups(graph.nodes, graph.edges, graph.mcpServers),
  );
  const framed = new Set(frames.flatMap((frame) => frame.memberIds));
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
  const landed =
    blocked === null
      ? groupOf(applyCanvasDrop(graph, drop), graph.mcpServers, dragged.id)
      : null;
  const split =
    blocked === null &&
    (landed === null ||
      !target.memberIds.every((id) => landed.memberIds.includes(id)));

  return {
    ...drop,
    refusal: blocked ?? (split ? splitReason(graph, dragged, target) : null),
    // The slot shown is the one the card really takes. Where code owns a sandbox
    // group's order, that is the place the rules give it, not the cursor's.
    slot: landed ? landed.memberIds.indexOf(dragged.id) : cursorSlot,
  };
}

/**
 * Nodes with the drop's order written where the derivation reads it.
 *
 * Two groups already order themselves by something that means more than looks,
 * so neither stores a slot: a sandbox group is its agents' `sandboxes`, which the
 * drop rewrites instead, and a machine MCP group follows the computers its
 * servers run on, so that its runs-on edges never cross. Every other group's
 * order is cosmetic and each member keeps its own slot. An agent code manages
 * keeps the order its project gives it.
 */
function orderedNodes(
  nodes: readonly Node[],
  edges: readonly Edge[],
  drop: CanvasDrop,
  order: readonly string[],
): Node[] {
  if (drop.kind === "mcp" && drop.key === "machine") return [...nodes];
  if (drop.kind !== "sandbox") {
    const slots = new Map(order.map((id, index) => [id, index]));

    return nodes.map((node) => {
      const slot = slots.get(node.id);

      return slot === undefined || node.data.frameOrder === slot
        ? node
        : { ...node, data: { ...node.data, frameOrder: slot } };
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
