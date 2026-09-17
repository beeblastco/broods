/**
 * Canvas frames: the groups sandbox, workspace and MCP cards sit in.
 *
 * Frames are derived, never stored. The dashboard draws them as parent nodes
 * and the tidy layout packs their members into slots, both from this module,
 * so the two agree on membership, order and geometry. A member node keeps
 * its absolute position in the saved layout; a frame's origin is read back
 * from its members. A group with one member is no frame: that node stays a
 * card, and becomes a chip once a second member joins its group.
 *
 * Pure on purpose: the dashboard imports it, so no Convex server imports.
 */

import type { LayoutEdge, LayoutNode, LayoutPosition } from "./canvasLayout";
import type { McpTransport } from "./mcp";

/** Member chip width inside a frame: room for a 20 character name. */
export const FRAME_CHIP_WIDTH = 184;

/**
 * Chip height per kind. A workspace chip carries a third line (the agents
 * sharing it) under its mount state, so it is taller.
 */
export const FRAME_CHIP_HEIGHTS: Record<FrameKind, number> = {
  sandbox: 44,
  workspace: 60,
  mcp: 44,
};

/** Vertical gap between two chips. */
export const FRAME_GAP = 8;

/** Title row above the first chip. */
export const FRAME_HEADER_HEIGHT = 28;

/** Inset left and right of the chips, and below the last one. */
export const FRAME_PADDING = 8;

export const FRAME_WIDTH = FRAME_CHIP_WIDTH + FRAME_PADDING * 2;

const FRAME_KIND_ORDER: Record<FrameKind, number> = {
  sandbox: 0,
  workspace: 1,
  mcp: 2,
};

const MCP_FRAME_LABELS: Record<McpTransport, string> = {
  http: "MCP · url",
  hosted: "MCP · hosted",
  machine: "MCP · your computer",
};

/** One derived group and the member nodes it holds; drawn as a frame from two members. */
export type CanvasFrame = {
  /** `frame:{owners}:{kind}:{key}`, stable while membership rules hold. */
  id: string;
  /** What splits groups of one kind: where a sandbox runs, a workspace's storage, an MCP transport. */
  key: string;
  kind: FrameKind;
  label: string;
  /** Sandboxes by order number then label; other kinds by label. */
  memberIds: string[];
  /** Sorted ids of the agents that reach every member. */
  ownerIds: string[];
};

/** The group a member node falls into, before ownership splits it. */
export type FrameGroup = {
  key: string;
  kind: FrameKind;
  label: string;
};

export type FrameKind = "sandbox" | "workspace" | "mcp";

/** What frame geometry reads from a group. */
export type FrameShape = Pick<CanvasFrame, "kind" | "memberIds">;

export type FrameSize = {
  height: number;
  width: number;
};

/** MCP transport of each saved server, keyed by the canvas node id it owns. */
export type McpTransportsByNode = ReadonlyMap<string, McpTransport>;

/**
 * Agents that reach each non-agent node, keyed by node id. Ownership is read
 * undirected over default edges, and a mount ties its two ends together: an
 * agent that reaches one reaches the other.
 */
export function agentOwners(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, Set<string>> {
  const agentIds = new Set(
    nodes.filter((node) => node.type === "agent").map((node) => node.id),
  );
  const owners = new Map<string, Set<string>>();
  const mountPairs: [string, string][] = [];

  for (const edge of edges) {
    const kind = edgeKind(edge);
    if (kind === "subagent") continue;
    if (kind === "mount") {
      if (!agentIds.has(edge.source) && !agentIds.has(edge.target)) {
        mountPairs.push([edge.source, edge.target]);
      }
      continue;
    }
    // The dashboard draws agent→service, but a reconnected edge can arrive
    // the other way round.
    const agentId = agentIds.has(edge.source)
      ? edge.source
      : agentIds.has(edge.target)
        ? edge.target
        : null;
    if (!agentId) continue;
    const serviceId = agentId === edge.source ? edge.target : edge.source;
    if (agentIds.has(serviceId)) continue;
    const current = owners.get(serviceId);
    if (current) current.add(agentId);
    else owners.set(serviceId, new Set([agentId]));
  }

  spreadOwnersOverMounts(owners, mountPairs);

  return owners;
}

/**
 * Sandbox node ids an agent reaches over a direct edge, in `sandboxes` order:
 * the agent node's stored `sandboxOrder` first, then any other direct sandbox
 * edge in edge order, so a freshly drawn sandbox lands last.
 */
export function agentSandboxOrder(
  agent: LayoutNode,
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): string[] {
  const sandboxIds = new Set(
    nodes.filter((node) => node.type === "sandbox").map((node) => node.id),
  );
  const wired = new Set<string>();
  for (const edge of edges) {
    if (edgeKind(edge) !== "default") continue;
    const otherId =
      edge.source === agent.id
        ? edge.target
        : edge.target === agent.id
          ? edge.source
          : null;
    if (otherId !== null && sandboxIds.has(otherId)) wired.add(otherId);
  }
  const stored: unknown = agent.data.sandboxOrder;
  const ordered = Array.isArray(stored)
    ? stored.filter(
        (id): id is string => typeof id === "string" && wired.has(id),
      )
    : [];

  return [...new Set([...ordered, ...wired])];
}

export function compareByLabel(a: LayoutNode, b: LayoutNode): number {
  return labelOf(a).localeCompare(labelOf(b));
}

/**
 * Every group on the canvas, one-member groups included. Only sandbox,
 * workspace and MCP nodes at least one agent reaches are grouped; unreached
 * ones stay standalone cards.
 */
export function deriveCanvasGroups(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpTransports: McpTransportsByNode,
): CanvasFrame[] {
  const owners = agentOwners(nodes, edges);
  const numbers = sandboxOrderNumbers(nodes, edges);
  const frames = new Map<string, CanvasFrame>();
  const members = new Map<string, LayoutNode[]>();

  for (const node of nodes) {
    const group = frameGroupOf(node, mcpTransports);
    const nodeOwners = owners.get(node.id);
    if (!group || !nodeOwners) continue;
    const ownerIds = [...nodeOwners].sort();
    const id = `frame:${ownerIds.join(",")}:${group.kind}:${group.key}`;
    const frameMembers = members.get(id);
    if (frameMembers) {
      frameMembers.push(node);
      continue;
    }
    members.set(id, [node]);
    frames.set(id, {
      id: id,
      key: group.key,
      kind: group.kind,
      label: group.label,
      memberIds: [],
      ownerIds: ownerIds,
    });
  }

  for (const frame of frames.values()) {
    frame.memberIds = (members.get(frame.id) ?? [])
      .sort(
        (a, b) =>
          orderNumberOf(numbers, a.id) - orderNumberOf(numbers, b.id) ||
          compareByLabel(a, b) ||
          a.id.localeCompare(b.id),
      )
      .map((member) => member.id);
  }

  return [...frames.values()].sort(
    (a, b) =>
      FRAME_KIND_ORDER[a.kind] - FRAME_KIND_ORDER[b.kind] ||
      lowestOrderNumber(numbers, a) - lowestOrderNumber(numbers, b) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
}

/** Edge kind, from the ReactFlow field when set, else from the persisted id prefix. */
export function edgeKind(edge: LayoutEdge): "mount" | "subagent" | "default" {
  if (edge.type === "mount" || edge.id.startsWith("mount:")) return "mount";
  if (edge.type === "subagent" || edge.id.startsWith("subagent:")) {
    return "subagent";
  }

  return "default";
}

/**
 * The frame group a node would join, or null for node types that are never
 * framed. Sandboxes split by where they run, workspaces by storage provider,
 * MCP servers by transport; a server not saved yet has no transport.
 */
export function frameGroupOf(
  node: LayoutNode,
  mcpTransports: McpTransportsByNode,
): FrameGroup | null {
  const config: unknown = node.data.config;
  if (node.type === "sandbox") {
    const provider =
      typeof config === "object" && config !== null && "provider" in config
        ? config.provider
        : undefined;

    return provider === "machine"
      ? { key: "machine", kind: "sandbox", label: "Your computer" }
      : { key: "cloud", kind: "sandbox", label: "Cloud sandbox" };
  }
  if (node.type === "workspace") {
    const storage =
      typeof config === "object" && config !== null && "storage" in config
        ? config.storage
        : undefined;
    const provider =
      typeof storage === "object" && storage !== null && "provider" in storage
        ? storage.provider
        : undefined;
    // A workspace saved without storage is materialized as S3.
    const key = typeof provider === "string" && provider ? provider : "s3";

    return {
      key: key,
      kind: "workspace",
      label: `Workspaces · ${key.toUpperCase()}`,
    };
  }
  if (node.type === "mcp") {
    const transport = mcpTransports.get(node.id);

    return transport
      ? { key: transport, kind: "mcp", label: MCP_FRAME_LABELS[transport] }
      : { key: "unsaved", kind: "mcp", label: "MCP" };
  }

  return null;
}

/** Absolute top-left of each member's slot, filled in `memberIds` order. */
export function frameMemberPositions(
  origin: LayoutPosition,
  frame: FrameShape,
): Map<string, LayoutPosition> {
  const step = FRAME_CHIP_HEIGHTS[frame.kind] + FRAME_GAP;

  return new Map(
    frame.memberIds.map((id, index) => [
      id,
      {
        x: origin.x + FRAME_PADDING,
        y: origin.y + FRAME_HEADER_HEIGHT + index * step,
      },
    ]),
  );
}

/** A frame's top-left, read back from its members' absolute positions. */
export function frameOriginOf(
  memberPositions: readonly LayoutPosition[],
): LayoutPosition {
  const x = Math.min(...memberPositions.map((position) => position.x));
  const y = Math.min(...memberPositions.map((position) => position.y));

  return { x: x - FRAME_PADDING, y: y - FRAME_HEADER_HEIGHT };
}

/** The groups drawn as frames: those with two members or more. */
export function framesOf(groups: readonly CanvasFrame[]): CanvasFrame[] {
  return groups.filter((group) => group.memberIds.length >= 2);
}

/** Expanded frame box for its kind and member count. */
export function frameSize(frame: FrameShape): FrameSize {
  const count = frame.memberIds.length;
  const chips =
    count * FRAME_CHIP_HEIGHTS[frame.kind] + Math.max(count - 1, 0) * FRAME_GAP;

  return {
    height: FRAME_HEADER_HEIGHT + chips + FRAME_PADDING,
    width: FRAME_WIDTH,
  };
}

/**
 * The sandbox each workspace inherits, by workspace node id: the default
 * sandbox of the first agent (by id) wired to it, for a workspace no
 * sandbox is mounted on and no `readOnly` flag forces read-only.
 */
export function inheritedSandboxIds(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, string> {
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const mounted = new Set<string>();
  const wired = new Set<string>();
  for (const edge of edges) {
    for (const [workspaceId, otherId] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (types.get(workspaceId) !== "workspace") continue;
      if (types.get(otherId) === "sandbox") mounted.add(workspaceId);
      if (types.get(otherId) === "agent")
        wired.add(`${otherId}\n${workspaceId}`);
    }
  }
  // By id, so the pick does not depend on the order nodes arrive in.
  const defaults = nodes
    .flatMap((agent): [string, string][] => {
      if (agent.type !== "agent") return [];
      const [first] = agentSandboxOrder(agent, nodes, edges);

      return first === undefined ? [] : [[agent.id, first]];
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return new Map(
    nodes.flatMap((workspace): [string, string][] => {
      if (
        workspace.type !== "workspace" ||
        mounted.has(workspace.id) ||
        workspace.data.readOnly === true
      ) {
        return [];
      }
      const inherited = defaults.find(([agentId]) =>
        wired.has(`${agentId}\n${workspace.id}`),
      );

      return inherited ? [[workspace.id, inherited[1]]] : [];
    }),
  );
}

/**
 * Each directly wired sandbox's 1-based place in `sandboxes`. A sandbox
 * several agents list takes its lowest place.
 */
export function sandboxOrderNumbers(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const agent of nodes) {
    if (agent.type !== "agent") continue;
    agentSandboxOrder(agent, nodes, edges).forEach((id, index) => {
      const current = numbers.get(id);
      if (current === undefined || index + 1 < current) {
        numbers.set(id, index + 1);
      }
    });
  }

  return numbers;
}

function labelOf(node: LayoutNode): string {
  return typeof node.data.label === "string" ? node.data.label : node.id;
}

function lowestOrderNumber(
  numbers: ReadonlyMap<string, number>,
  frame: CanvasFrame,
): number {
  return Math.min(...frame.memberIds.map((id) => orderNumberOf(numbers, id)));
}

/** Order number for sorting; nodes without one sort after every numbered node. */
function orderNumberOf(
  numbers: ReadonlyMap<string, number>,
  nodeId: string,
): number {
  return numbers.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Give both ends of every mount every owner either end has. Repeats until
 * nothing changes, so a chain of mounts settles on one owner set too.
 */
function spreadOwnersOverMounts(
  owners: Map<string, Set<string>>,
  mountPairs: readonly (readonly [string, string])[],
): void {
  let spread = true;
  while (spread) {
    spread = false;
    for (const [a, b] of mountPairs) {
      const ownersA = owners.get(a) ?? new Set<string>();
      const ownersB = owners.get(b) ?? new Set<string>();
      const merged = new Set([...ownersA, ...ownersB]);
      if (merged.size === ownersA.size && merged.size === ownersB.size) {
        continue;
      }
      owners.set(a, merged);
      owners.set(b, new Set(merged));
      spread = true;
    }
  }
}
