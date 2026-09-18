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
 * The one thing about a group that is stored is the exception: a node whose
 * `data.ungrouped` is set joins no group at all and stays a card, which is
 * how the canvas pulls a member out of a frame.
 *
 * Also the relations frames and layout both read off the flat graph: which
 * agents reference a resource, which sandbox a workspace resolves to, and
 * which computer a machine MCP server runs on.
 *
 * Pure on purpose: the dashboard imports it, so no Convex server imports.
 */

import type { LayoutEdge, LayoutNode, LayoutPosition } from "./canvasLayout";
import type { McpPlacement, McpTransport } from "./mcp";

/**
 * Member chip width inside a frame: `NODE_WIDTH` from `canvasLayout.ts`, so a
 * row and a card are the same width. Inlined; that module imports this one.
 */
export const FRAME_CHIP_WIDTH = 176;

/** Member chip height: a name line and a status line, the same for every kind. */
export const FRAME_CHIP_HEIGHT = 44;

/** Vertical gap between two chips. */
export const FRAME_GAP = 8;

/** Title row above the first chip. */
export const FRAME_HEADER_HEIGHT = 28;

/**
 * Slot height of the one chip a click opens: `NODE_HEIGHT` from
 * `canvasLayout.ts`, so an open chip is a card. Inlined; that module imports
 * this one.
 */
export const FRAME_MEMBER_CARD_HEIGHT = 96;

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
  /**
   * Sandboxes by order number, machine MCP servers by their computer's order
   * number, then by label.
   */
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

/** Each saved MCP server's placement, keyed by the canvas node id it owns. */
export type McpServersByNode = ReadonlyMap<string, McpPlacement>;

/**
 * A workspace's effective sandbox, by the broods cascade
 * `ws.sandbox (override) ?? config.sandboxes[0] (inherited) ?? none (read-only)`.
 * Inherited lists every distinct default of the agents wired to it: each agent
 * runs the workspace on its own default.
 */
export type WorkspaceSandboxIds =
  | { kind: "inherited"; sandboxIds: string[] }
  | { kind: "override"; sandboxIds: string[] }
  | { kind: "readonly" };

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
 * How many distinct agents reference each sandbox and workspace: a sandbox in
 * an agent's `sandboxes`, a workspace an agent wires, and a sandbox mounted
 * into such a workspace.
 */
export function agentRefCounts(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, number> {
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const refs = new Map<string, Set<string>>();
  const addRef = (nodeId: string, agentId: string): void => {
    const agents = refs.get(nodeId);
    if (agents) agents.add(agentId);
    else refs.set(nodeId, new Set([agentId]));
  };
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = neighbours.get(from);
    if (list) list.push(to);
    else neighbours.set(from, [to]);
  };
  for (const edge of edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  for (const [agentId, sandboxIds] of agentSandboxOrders(nodes, edges)) {
    for (const sandboxId of sandboxIds) addRef(sandboxId, agentId);
    for (const workspaceId of neighbours.get(agentId) ?? []) {
      if (types.get(workspaceId) !== "workspace") continue;
      addRef(workspaceId, agentId);
      for (const mountId of neighbours.get(workspaceId) ?? []) {
        if (types.get(mountId) === "sandbox") addRef(mountId, agentId);
      }
    }
  }

  return new Map([...refs].map(([id, agents]) => [id, agents.size]));
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
  return sandboxOrdersFor([agent], nodes, edges).get(agent.id) ?? [];
}

/**
 * {@link agentSandboxOrder} for every agent at once, in one pass over the
 * edges, for the readers that need all of them.
 */
export function agentSandboxOrders(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, string[]> {
  return sandboxOrdersFor(
    nodes.filter((node) => node.type === "agent"),
    nodes,
    edges,
  );
}

/**
 * The place each sandbox card shows: its 1-based place in its agents'
 * `sandboxes`, only where every agent that wires it gives it the same place
 * and at least one of them lists more than one sandbox. A shared sandbox that
 * is first for one agent and second for another has no number, and neither
 * does an agent's only sandbox: with nothing to order, "1 · default" says
 * nothing. Frames sort by `sandboxOrderNumbers` instead, which always numbers.
 */
export function agreedSandboxOrderNumbers(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, number> {
  const numbers = new Map<string, number | null>();
  const ordered = new Set<string>();
  for (const sandboxIds of agentSandboxOrders(nodes, edges).values()) {
    sandboxIds.forEach((id, index): void => {
      const current = numbers.get(id);
      numbers.set(
        id,
        current === undefined || current === index + 1 ? index + 1 : null,
      );
      if (sandboxIds.length > 1) ordered.add(id);
    });
  }

  return new Map(
    [...numbers].flatMap(([id, number]): [string, number][] =>
      number === null || !ordered.has(id) ? [] : [[id, number]],
    ),
  );
}

export function compareByLabel(a: LayoutNode, b: LayoutNode): number {
  return labelOf(a).localeCompare(labelOf(b));
}

/**
 * Every group on the canvas, one-member groups included. Only sandbox,
 * workspace and MCP nodes at least one agent reaches are grouped; unreached
 * ones stay standalone cards, and so does a node pulled out by hand
 * (`data.ungrouped`).
 */
export function deriveCanvasGroups(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  mcpServers: McpServersByNode,
): CanvasFrame[] {
  const owners = agentOwners(nodes, edges);
  const sandboxNumbers = sandboxOrderNumbers(nodes, edges);
  // A machine MCP server sorts by the place of the computer it runs on, so
  // servers line up with their computers and runs-on edges never cross.
  const numbers = new Map(sandboxNumbers);
  for (const [mcpId, sandboxId] of runsOnSandboxIds(nodes, mcpServers)) {
    const number = sandboxNumbers.get(sandboxId);
    if (number !== undefined) numbers.set(mcpId, number);
  }
  const frames = new Map<string, CanvasFrame>();
  const members = new Map<string, LayoutNode[]>();

  for (const node of nodes) {
    if (node.data.ungrouped === true) continue;
    const group = frameGroupOf(node, mcpServers);
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
  mcpServers: McpServersByNode,
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
    // A workspace saved without storage is materialized as S3. The provider
    // splits groups but stays out of the label while S3 is the only one.
    const key = typeof provider === "string" && provider ? provider : "s3";

    return { key: key, kind: "workspace", label: "Workspaces" };
  }
  if (node.type === "mcp") {
    const transport = mcpServers.get(node.id)?.transport;

    return transport
      ? { key: transport, kind: "mcp", label: MCP_FRAME_LABELS[transport] }
      : { key: "unsaved", kind: "mcp", label: "MCP" };
  }

  return null;
}

/**
 * Absolute top-left of each member's slot, filled in `memberIds` order. With
 * `expandedId` that member takes a card's slot and pushes the ones under it
 * down; the saved layout is packed without it, so an open chip moves no
 * stored position.
 */
export function frameMemberPositions(
  origin: LayoutPosition,
  frame: FrameShape,
  expandedId?: string,
): Map<string, LayoutPosition> {
  let y = origin.y + FRAME_HEADER_HEIGHT;

  return new Map(
    frame.memberIds.map((id): [string, LayoutPosition] => {
      const slot = { x: origin.x + FRAME_PADDING, y: y };
      y += memberSlotHeight(id, expandedId) + FRAME_GAP;

      return [id, slot];
    }),
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

/** Open frame box for its kind and member count, taller around an open chip. */
export function frameSize(frame: FrameShape, expandedId?: string): FrameSize {
  const chips = frame.memberIds.reduce(
    (total, id) => total + memberSlotHeight(id, expandedId),
    Math.max(frame.memberIds.length - 1, 0) * FRAME_GAP,
  );

  return {
    height: FRAME_HEADER_HEIGHT + chips + FRAME_PADDING,
    width: FRAME_WIDTH,
  };
}

/**
 * Whether an edge id names a `broods/` project endpoint: a `cli-` node id right
 * after the kind prefix, the way the CLI sync writes every edge it creates. The
 * sync prunes such an edge its config no longer lists, and the dashboard locks
 * it.
 */
export function isCliEdgeId(id: string): boolean {
  return (
    id.startsWith("mount:cli-") ||
    id.startsWith("subagent:cli-") ||
    id.startsWith("xy-edge__cli-")
  );
}

/**
 * The sandbox node each machine MCP server runs on, by the server's node id:
 * the sandbox whose mount name, or else label, is the server's `sandbox`.
 */
export function runsOnSandboxIds(
  nodes: readonly LayoutNode[],
  mcpServers: McpServersByNode,
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== "sandbox") continue;
    const name = node.data.mountName ?? node.data.label;
    if (typeof name === "string" && !byName.has(name))
      byName.set(name, node.id);
  }

  return new Map(
    [...mcpServers].flatMap(([nodeId, server]): [string, string][] => {
      const sandboxId =
        server.transport === "machine" && server.sandbox !== null
          ? byName.get(server.sandbox)
          : undefined;

      return sandboxId === undefined ? [] : [[nodeId, sandboxId]];
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
  for (const sandboxIds of agentSandboxOrders(nodes, edges).values()) {
    sandboxIds.forEach((id, index) => {
      const current = numbers.get(id);
      if (current === undefined || index + 1 < current) {
        numbers.set(id, index + 1);
      }
    });
  }

  return numbers;
}

/**
 * Sandboxes no agent wires that a workspace mounts: they run only that
 * workspace's files, so they have no place in any `sandboxes` to number.
 */
export function workspaceOnlySandboxIds(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Set<string> {
  const listed = new Set([...agentSandboxOrders(nodes, edges).values()].flat());
  const sandboxIds = new Set(
    nodes
      .filter((node): boolean => node.type === "sandbox")
      .map((node): string => node.id),
  );

  return new Set(
    edges
      .filter((edge): boolean => edgeKind(edge) === "mount")
      .flatMap((edge): string[] => [edge.source, edge.target])
      .filter((id): boolean => sandboxIds.has(id) && !listed.has(id)),
  );
}

/**
 * Each workspace's effective sandboxes. A sandbox wired to it is a mount; with
 * none, a `readOnly` flag forces read-only (the pure graph cannot express a
 * `sandbox: null` ref); otherwise it inherits the default of every agent wired
 * to it that has one, and is read-only when none does.
 */
export function workspaceSandboxIds(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, WorkspaceSandboxIds> {
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const mounts = new Map<string, string[]>();
  const agents = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const [workspaceId, otherId] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (types.get(workspaceId) !== "workspace") continue;
      if (types.get(otherId) === "sandbox") {
        const mounted = mounts.get(workspaceId);
        if (mounted) mounted.push(otherId);
        else mounts.set(workspaceId, [otherId]);
      }
      if (types.get(otherId) === "agent") {
        const wired = agents.get(workspaceId);
        if (wired) wired.add(otherId);
        else agents.set(workspaceId, new Set([otherId]));
      }
    }
  }
  const defaults = new Map(
    [...agentSandboxOrders(nodes, edges)].flatMap(
      ([agentId, [first]]): [string, string][] =>
        first === undefined ? [] : [[agentId, first]],
    ),
  );

  return new Map(
    nodes.flatMap((workspace): [string, WorkspaceSandboxIds][] => {
      if (workspace.type !== "workspace") return [];
      const mounted = mounts.get(workspace.id);
      if (mounted) {
        return [
          [
            workspace.id,
            { kind: "override", sandboxIds: [...new Set(mounted)] },
          ],
        ];
      }
      // Sorted, so the list does not depend on the order edges arrive in.
      const inherited = [
        ...new Set(
          [...(agents.get(workspace.id) ?? [])]
            .sort()
            .flatMap((agentId) => defaults.get(agentId) ?? []),
        ),
      ];

      return [
        [
          workspace.id,
          workspace.data.readOnly === true || inherited.length === 0
            ? { kind: "readonly" }
            : { kind: "inherited", sandboxIds: inherited },
        ],
      ];
    }),
  );
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

/** The slot a member fills: a chip's, or a card's while it is the open one. */
function memberSlotHeight(id: string, expandedId: string | undefined): number {
  return id === expandedId ? FRAME_MEMBER_CARD_HEIGHT : FRAME_CHIP_HEIGHT;
}

/** Order number for sorting; nodes without one sort after every numbered node. */
function orderNumberOf(
  numbers: ReadonlyMap<string, number>,
  nodeId: string,
): number {
  return numbers.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
}

/** The `sandboxes` order of each of `agents`, reading every edge once. */
function sandboxOrdersFor(
  agents: readonly LayoutNode[],
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, string[]> {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const sandboxIds = new Set(
    nodes.filter((node) => node.type === "sandbox").map((node) => node.id),
  );
  const wired = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edgeKind(edge) !== "default") continue;
    for (const [agentId, otherId] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (!agentIds.has(agentId) || !sandboxIds.has(otherId)) continue;
      const sandboxes = wired.get(agentId);
      if (sandboxes) sandboxes.add(otherId);
      else wired.set(agentId, new Set([otherId]));
    }
  }

  return new Map(
    agents.map((agent): [string, string[]] => {
      const sandboxes = wired.get(agent.id) ?? new Set<string>();
      const stored: unknown = agent.data.sandboxOrder;
      const ordered = Array.isArray(stored)
        ? stored.filter(
            (id): id is string => typeof id === "string" && sandboxes.has(id),
          )
        : [];

      return [agent.id, [...new Set([...ordered, ...sandboxes])]];
    }),
  );
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
