/**
 * Edits on the flat canvas graph that frames care about: where cards go when
 * an edit changes which frame they belong to, what a chip's menu offers, and
 * the order numbers chips show. Pure, so each rule is unit-tested here.
 */
import { isCodeManagedOwner } from "@/app/components/canvas/edgeOwnership";
import { deriveFrames, type StageMcpServer } from "@/app/lib/canvasFrameNodes";
import {
  runtimeRefsProblems,
  type RuntimeRefsProblem,
} from "@/app/lib/canvasRuntimeRefs";
import {
  agentSandboxOrder,
  edgeKind,
  frameMemberPositions,
  frameOriginOf,
  frameSize,
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

/** The card box, for the free-spot search. */
const CARD_SIZE: FrameSize = { height: NODE_HEIGHT, width: NODE_WIDTH };

/** A flat graph as one edit sees it, with the server list its frames depend on. */
export type FlatGraph = {
  edges: Edge[];
  /** Undefined while loading; MCP nodes are not framed until then. */
  mcpServers: readonly StageMcpServer[] | undefined;
  nodes: Node[];
};

/**
 * What a right-click on a chip can do, per agent that wires it directly.
 * `agentLabel` names the agent only when several do, so the entries differ.
 * Make default carries why it is refused, when the config API would refuse it.
 */
export type FrameMemberAction =
  | {
      kind: "make-default";
      agentId: string;
      agentLabel: string | null;
      disabledReason: string | null;
    }
  | { kind: "remove"; agentLabel: string | null; edgeId: string };

/**
 * Each directly wired sandbox's 1-based place in its agents' `sandboxes`,
 * only where every agent that wires it gives it the same place. A shared
 * sandbox that is first for one agent and second for another has no number.
 */
export function agreedSandboxOrderNumbers(
  nodes: readonly Node[],
  edges: readonly Edge[],
): Map<string, number> {
  const numbers = new Map<string, number | null>();
  for (const agent of nodes) {
    if (agent.type !== "agent") continue;
    agentSandboxOrder(agent, nodes, edges).forEach((id, index) => {
      const current = numbers.get(id);
      numbers.set(
        id,
        current === undefined || current === index + 1 ? index + 1 : null,
      );
    });
  }

  return new Map(
    [...numbers].flatMap(([id, number]): [string, number][] =>
      number === null ? [] : [[id, number]],
    ),
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
  const sizes = new Map(
    frames.map((frame) => [frame.id, frameSize(frame.memberIds.length)]),
  );

  return displayNodes
    .filter((node) => node.parentId === undefined)
    .map((node) => ({
      ...node.position,
      ...(sizes.get(node.id) ?? CARD_SIZE),
    }));
}

/**
 * Chip context menu entries. Make default only where the sandbox is not
 * already first and the agent is not code-managed (code owns its order), and
 * disabled where the new order breaks the runtime rules; remove only where the
 * edge is not locked.
 */
export function frameMemberActions(
  nodes: Node[],
  edges: Edge[],
  memberId: string,
): FrameMemberAction[] {
  const member = nodes.find((node) => node.id === memberId);
  if (!member) return [];
  const agents = new Map(
    nodes
      .filter((node) => node.type === "agent")
      .map((node) => [node.id, node]),
  );
  const wired = edges.flatMap((edge) => {
    if (edgeKind(edge) !== "default") return [];
    const otherId =
      edge.source === memberId
        ? edge.target
        : edge.target === memberId
          ? edge.source
          : null;
    const agent = otherId === null ? undefined : agents.get(otherId);

    return agent ? [{ agent: agent, edge: edge }] : [];
  });
  const labelFor = (agent: Node): string | null =>
    wired.length > 1 && typeof agent.data.label === "string"
      ? agent.data.label
      : null;

  return wired.flatMap(({ agent, edge }): FrameMemberAction[] => {
    const actions: FrameMemberAction[] = [];
    if (
      member.type === "sandbox" &&
      !isCodeManagedOwner(agent.data.managedBy) &&
      agentSandboxOrder(agent, nodes, edges)[0] !== memberId
    ) {
      const problem = introducedRuntimeRefsProblem(
        { edges: edges, nodes: nodes },
        {
          edges: edges,
          nodes: makeDefaultSandbox(nodes, edges, agent.id, memberId),
        },
      );
      actions.push({
        agentId: agent.id,
        agentLabel: labelFor(agent),
        disabledReason: problem
          ? `${problem.workspaceName} is mounted on ${problem.sandboxLabel}`
          : null,
        kind: "make-default",
      });
    }
    if (edge.deletable !== false) {
      actions.push({
        agentLabel: labelFor(agent),
        edgeId: edge.id,
        kind: "remove",
      });
    }

    return actions;
  });
}

/**
 * The first runtime-ref problem `after` has that `before` did not, or null.
 * Used to refuse an edit up front: a problem the graph already had is not
 * this edit's to block.
 */
export function introducedRuntimeRefsProblem(
  before: Pick<FlatGraph, "edges" | "nodes">,
  after: Pick<FlatGraph, "edges" | "nodes">,
): RuntimeRefsProblem | null {
  const keyOf = (problem: RuntimeRefsProblem): string =>
    `${problem.agentId}\n${problem.workspaceName}\n${problem.sandboxLabel}`;
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
 * Flat nodes of `next` with positions settled after an edit that may change
 * frame membership. A frame that was already drawn keeps its origin whoever
 * joins or leaves it, and its members take its slots. A new frame starts
 * where its members stand, stepped clear of every other box. A card that left
 * all frames steps clear of the frame it sat in. Frames whose members did not
 * change, and cards that stay cards, are not moved. Returns `next.nodes`
 * itself when nothing moves.
 */
export function reconcileFramePositions(
  previous: FlatGraph,
  next: FlatGraph,
): Node[] {
  const before = deriveFrames(
    previous.nodes,
    previous.edges,
    previous.mcpServers,
  );
  const after = deriveFrames(next.nodes, next.edges, next.mcpServers);
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
      for (const [id, position] of frameMemberPositions(
        origin,
        frame.memberIds,
      )) {
        moves.set(id, position);
      }
    }
    occupied.push({ ...origin, ...frameSize(frame.memberIds.length) });
  };

  for (const frame of after) {
    const kept = beforeById.get(frame.id);
    if (!kept) continue;
    const unchanged = kept.memberIds.join("\n") === frame.memberIds.join("\n");
    place(frame, originOf(kept.memberIds, previousPositions), !unchanged);
  }
  for (const node of next.nodes) {
    if (framedBefore.has(node.id) || framedAfter.has(node.id)) continue;
    occupied.push({ ...node.position, ...CARD_SIZE });
  }
  for (const frame of after) {
    if (beforeById.has(frame.id)) continue;
    const size = frameSize(frame.memberIds.length);
    place(
      frame,
      findFreeBox(originOf(frame.memberIds, nextPositions), size, occupied),
      true,
    );
  }
  for (const node of next.nodes) {
    if (!framedBefore.has(node.id) || framedAfter.has(node.id)) continue;
    const position = findFreePosition(node.position, occupied);
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
