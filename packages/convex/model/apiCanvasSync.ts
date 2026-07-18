/**
 * Mirrors API-managed agents' runtime wiring onto the dashboard canvas — the
 * account-API counterpart of cliSync's `syncCanvasLayoutForManifest`.
 *
 * An agent created or updated through the public account API carries its
 * wiring inline in the encrypted config blob (`sandbox`, `workspaces`,
 * `skills.allowed`, `subagent.allowed`). The canvas never sees any of it: the
 * back-sync only drops a bare agent node, so the Architecture view shows an
 * agent floating with no workspace, sandbox, or skills even though the runtime
 * resolves all of them. This module recomputes the desired wiring for every
 * `managedBy: "api"` agent in an environment and materializes it as locked
 * `managedBy: "api"` nodes and edges, so the canvas mirrors the API config
 * without ever fighting its owner.
 *
 * Referenced workspace/sandbox rows created through the API are account-scoped
 * (no project/environment). They are adopted into the canvas environment here
 * — without adoption `materializeRuntimeNodes` rejects them on the next
 * dashboard save ("belongs to a different project or environment").
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { decryptAgentConfigBlob } from "./agentConfigCodec";
import { isPlainObject } from "./objects";

/** Persisted canvas node shape (mirrors `canvasNodeValidator`). */
type CanvasNode = {
  id: string;
  type: "agent" | "database" | "sandbox" | "workspace" | "tool" | "skill";
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

/** Persisted canvas edge shape (mirrors `canvasEdgeValidator`). */
type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
};

/**
 * Recomputes the desired API-managed wiring for one environment's canvas and
 * patches the layout: locked workspace/sandbox/skill nodes, agent→resource
 * edges, and pruning of wiring the configs no longer declare. Resources are
 * resolved against each agent's own account, so a mixed environment never
 * aliases or prunes another account's wiring. Agents whose blob cannot be
 * decrypted keep their existing wiring untouched.
 */
export async function syncApiAgentCanvasWiring(
  ctx: MutationCtx,
  options: {
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
  },
): Promise<void> {
  const { projectId, environmentId } = options;
  // Without the shared secret no blob can be decrypted, so no wiring is known;
  // leave the canvas untouched rather than pruning edges we cannot recompute.
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    return;
  }

  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .unique();
  if (!layout) {
    return;
  }

  const existingNodes = (layout.nodes as CanvasNode[]).map((node) => ({
    id: String(node.id),
    type: node.type,
    position: node.position ?? { x: 0, y: 0 },
    data: isPlainObject(node.data) ? node.data : {},
  }));
  const existingEdges: CanvasEdge[] = (layout.edges as CanvasEdge[]).map(
    (edge) => ({
      id: String(edge.id),
      source: String(edge.source),
      target: String(edge.target),
      animated: edge.animated,
    }),
  );
  const nextById = new Map(existingNodes.map((node) => [node.id, node]));
  const existingByAgentConfigId = new Map<string, CanvasNode>();
  const existingByResourceId = new Map<string, CanvasNode>();
  for (const node of existingNodes) {
    if (typeof node.data.agentConfigId === "string")
      existingByAgentConfigId.set(node.data.agentConfigId, node);
    if (typeof node.data.resourceId === "string")
      existingByResourceId.set(node.data.resourceId, node);
  }

  const configs = (
    await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_environmentId", (q) =>
        q.eq("projectId", projectId).eq("environmentId", environmentId),
      )
      .collect()
  ).filter((config) => config.managedBy === "api" && config.agentId);

  /** Lazily loaded skill names per owning account. */
  const skillNamesByAccount = new Map<Id<"accounts">, Set<string>>();
  const skillNamesFor = async (
    ownerAccountId: Id<"accounts">,
  ): Promise<Set<string>> => {
    const cached = skillNamesByAccount.get(ownerAccountId);
    if (cached) {
      return cached;
    }
    const names = new Set(
      (
        await ctx.db
          .query("skills")
          .withIndex("by_accountId", (q) => q.eq("accountId", ownerAccountId))
          .collect()
      ).map((skill) => skill.name),
    );
    skillNamesByAccount.set(ownerAccountId, names);

    return names;
  };

  // Same column layout as the CLI canvas sync; agents keep whatever position
  // the back-sync or the user gave them.
  const columnX = { sandbox: 340, workspace: 600, skill: 860 } as const;
  const rowY = { sandbox: 80, workspace: 80, skill: 80 };

  /** Next free slot in a resource kind's column. */
  const nextPosition = (kind: keyof typeof columnX) => {
    const position = { x: columnX[kind], y: rowY[kind] };
    rowY[kind] += 132;

    return position;
  };

  /** Creates or refreshes a node in `nextById`, keeping any existing position. */
  const upsertNode = (
    preferred: CanvasNode | undefined,
    id: string,
    kind: CanvasNode["type"],
    position: { x: number; y: number },
    data: Record<string, unknown>,
  ): CanvasNode => {
    const nodeId = preferred?.id ?? id;
    const existing = preferred ?? nextById.get(nodeId);
    const node = {
      id: nodeId,
      type: kind,
      position: existing?.position ?? position,
      data: { ...(existing?.data ?? {}), ...data },
    };
    nextById.set(nodeId, node);

    return node;
  };

  /**
   * Adopt an API-created (account-scoped) row into this environment so canvas
   * saves accept it; rows owned by another account or living in another
   * environment cannot be drawn here and are skipped. Dashboard-owned rows in
   * this environment keep their owner — an API agent may reference a
   * dashboard-created resource without stealing it.
   */
  const adoptRow = async (
    row: Doc<"workspaceConfigs"> | Doc<"sandboxConfigs">,
    ownerAccountId: Id<"accounts">,
  ): Promise<boolean> => {
    if (row.accountId !== ownerAccountId) {
      return false;
    }
    if (row.environmentId === undefined) {
      await ctx.db.patch(row._id, {
        projectId: projectId,
        environmentId: environmentId,
        managedBy: "api",
        updatedAt: Date.now(),
      });

      return true;
    }

    return row.environmentId === environmentId;
  };

  const desiredEdges = new Map<string, CanvasEdge>();
  const desiredWiringNodeIds = new Set<string>();
  const workspaceReferenced = new Set<string>();
  const workspaceHasWriter = new Set<string>();
  const agentNodeByConfigId = new Map<string, string>();
  // Agent nodes whose config blob could not be read this pass: their existing
  // wiring must survive reconciliation, since the desired state is unknown.
  const unresolvedAgentNodeIds = new Set<string>();

  /** Resolves a sandbox ref into an adopted, materialized node id. */
  const sandboxNodeFor = async (
    sandboxRef: unknown,
    ownerAccountId: Id<"accounts">,
  ): Promise<string | null> => {
    if (typeof sandboxRef !== "string" || !sandboxRef.trim()) {
      return null;
    }
    const normalized = ctx.db.normalizeId("sandboxConfigs", sandboxRef);
    if (!normalized) {
      return null;
    }
    const row = await ctx.db.get(normalized);
    if (!row || !(await adoptRow(row, ownerAccountId))) {
      return null;
    }
    const node = upsertNode(
      existingByResourceId.get(row._id),
      `api-sandbox-${row._id}`,
      "sandbox",
      nextPosition("sandbox"),
      {
        label: row.name,
        status: "idle",
        resourceId: row._id,
        mountName: row.name,
        description: row.description,
        managedBy: "api",
      },
    );
    desiredWiringNodeIds.add(node.id);

    return node.id;
  };

  for (const config of configs) {
    const agentRowId = ctx.db.normalizeId("agents", config.agentId!);
    const agent = agentRowId ? await ctx.db.get(agentRowId) : null;
    const nested =
      agent?.encryptedConfig && agent.encryptionIv && agent.encryptionTag
        ? await decryptAgentConfigBlob(
            {
              ciphertext: agent.encryptedConfig,
              iv: agent.encryptionIv,
              tag: agent.encryptionTag,
            },
            secret,
          )
        : null;
    if (!agent || !nested) {
      const agentNode = existingByAgentConfigId.get(config._id);
      if (agentNode) unresolvedAgentNodeIds.add(agentNode.id);
      continue;
    }

    const agentNode = upsertNode(
      existingByAgentConfigId.get(config._id),
      `api-agent-${config._id}`,
      "agent",
      { x: 80, y: 80 },
      {
        label: config.name,
        agentConfigId: config._id,
        managedBy: "api",
      },
    );
    agentNodeByConfigId.set(config._id, agentNode.id);

    const defaultSandboxNodeId = await sandboxNodeFor(
      nested.sandbox,
      agent.accountId,
    );
    if (defaultSandboxNodeId)
      addDefaultEdge(desiredEdges, agentNode.id, defaultSandboxNodeId);

    if (Array.isArray(nested.workspaces)) {
      for (const ref of nested.workspaces) {
        if (!isPlainObject(ref) || typeof ref.workspaceId !== "string")
          continue;
        const normalized = ctx.db.normalizeId(
          "workspaceConfigs",
          ref.workspaceId,
        );
        if (!normalized) continue;
        const row = await ctx.db.get(normalized);
        if (!row || !(await adoptRow(row, agent.accountId))) continue;
        const workspaceNode = upsertNode(
          existingByResourceId.get(row._id),
          `api-workspace-${row._id}`,
          "workspace",
          nextPosition("workspace"),
          {
            label: row.name,
            status: "idle",
            resourceId: row._id,
            // The agent's ref name is the mount path the runtime uses; prefer
            // it over the row name so a canvas round-trip derives the same ref.
            mountName:
              typeof ref.name === "string" && ref.name.trim()
                ? ref.name.trim()
                : row.name,
            description: row.description,
            config: row.config,
            managedBy: "api",
          },
        );
        desiredWiringNodeIds.add(workspaceNode.id);
        addDefaultEdge(desiredEdges, agentNode.id, workspaceNode.id);
        workspaceReferenced.add(workspaceNode.id);
        if (typeof ref.sandbox === "string") {
          // Per-workspace sandbox override → writable, drawn as a mount edge.
          // A ref that fails to resolve grants no writer: readOnly must never
          // claim writability without the mount edge that backs it.
          const overrideNodeId = await sandboxNodeFor(
            ref.sandbox,
            agent.accountId,
          );
          if (overrideNodeId) {
            workspaceHasWriter.add(workspaceNode.id);
            addMountEdge(desiredEdges, workspaceNode.id, overrideNodeId);
          }
        } else if (ref.sandbox !== null && defaultSandboxNodeId) {
          // Omitted sandbox inherits the agent-level default (writable);
          // `null` explicitly forces read-only, so it stays a non-writer.
          workspaceHasWriter.add(workspaceNode.id);
        }
      }
    }

    const skills = nested.skills;
    if (
      isPlainObject(skills) &&
      skills.enabled !== false &&
      Array.isArray(skills.allowed)
    ) {
      const skillNames = await skillNamesFor(agent.accountId);
      for (const entry of skills.allowed) {
        if (typeof entry !== "string" || !entry.trim()) continue;
        // Allowed refs are `<accountId>/<name>` paths; the node id carries the
        // owning account so same-named skills never alias across accounts.
        const name = entry.slice(entry.lastIndexOf("/") + 1).trim();
        if (!name || !skillNames.has(name)) continue;
        const skillNodeId = `api-skill-${agent.accountId}-${name}`;
        const skillNode = upsertNode(
          nextById.get(skillNodeId),
          skillNodeId,
          "skill",
          nextPosition("skill"),
          {
            label: name,
            status: "idle",
            resourceId: name,
            managedBy: "api",
          },
        );
        desiredWiringNodeIds.add(skillNode.id);
        addDefaultEdge(desiredEdges, agentNode.id, skillNode.id);
      }
    }

    const subagent = nested.subagent;
    if (isPlainObject(subagent) && Array.isArray(subagent.allowed)) {
      for (const entry of subagent.allowed) {
        if (typeof entry !== "string" || !entry.trim()) continue;
        const callee = configs.find((other) => other.agentId === entry);
        const calleeNodeId = callee
          ? (agentNodeByConfigId.get(callee._id) ??
            existingByAgentConfigId.get(callee._id)?.id)
          : undefined;
        if (calleeNodeId && calleeNodeId !== agentNode.id) {
          const id = `subagent:${agentNode.id}-right-${calleeNodeId}-left`;
          desiredEdges.set(id, {
            id: id,
            source: agentNode.id,
            target: calleeNodeId,
            animated: false,
          });
        }
      }
    }
  }

  // Stamp the resolved read-only state onto referenced workspace nodes; an
  // explicit `false` clears a stale flag once a writer exists.
  for (const nodeId of desiredWiringNodeIds) {
    const node = nextById.get(nodeId);
    if (node?.type !== "workspace") continue;
    node.data = {
      ...node.data,
      readOnly:
        workspaceReferenced.has(nodeId) && !workspaceHasWriter.has(nodeId),
    };
  }

  /** API-managed edge: both endpoints are API-owned nodes. */
  const isApiManagedEdge = (edge: CanvasEdge) =>
    nextById.get(edge.source)?.data.managedBy === "api" &&
    nextById.get(edge.target)?.data.managedBy === "api";
  // Stale API wiring is pruned; user-drawn edges and the wiring of agents
  // whose desired state is unknown this pass survive.
  const existingEdgeIds = new Set(existingEdges.map((edge) => edge.id));
  const keptEdges = existingEdges.filter(
    (edge) =>
      desiredEdges.has(edge.id) ||
      !isApiManagedEdge(edge) ||
      unresolvedAgentNodeIds.has(edge.source) ||
      unresolvedAgentNodeIds.has(edge.target),
  );
  for (const edge of desiredEdges.values()) {
    if (existingEdgeIds.has(edge.id)) continue;
    keptEdges.push(edge);
  }

  // Prune API-managed wiring nodes nothing references anymore: neither the
  // desired sets nor a surviving edge (an unresolved agent's wiring). Agent
  // nodes are owned by the create/remove back-sync, not by this wiring pass.
  const edgeEndpointIds = new Set(
    keptEdges.flatMap((edge) => [edge.source, edge.target]),
  );
  const nextNodes = [...nextById.values()].filter(
    (node) =>
      node.type === "agent" ||
      node.data.managedBy !== "api" ||
      desiredWiringNodeIds.has(node.id) ||
      edgeEndpointIds.has(node.id),
  );

  // Invariant: every persisted edge has two persisted endpoints — a pruned or
  // externally deleted node must take its edges with it.
  const nextNodeIds = new Set(nextNodes.map((node) => node.id));
  const nextEdges = keptEdges.filter(
    (edge) => nextNodeIds.has(edge.source) && nextNodeIds.has(edge.target),
  );

  await ctx.db.patch(layout._id, {
    nodes: nextNodes,
    edges: nextEdges,
    updatedAt: Date.now(),
  });
}

/** Default agent→service edge, matching the dashboard's `xy-edge__` id scheme. */
function addDefaultEdge(
  edges: Map<string, CanvasEdge>,
  source: string,
  target: string,
): void {
  const id = `xy-edge__${source}-${target}`;
  edges.set(id, { id: id, source: source, target: target, animated: true });
}

/**
 * Side-handle mount edge for a workspace↔sandbox override, matching the
 * dashboard's `mount:` id scheme (handles are rebuilt from the id on load).
 */
function addMountEdge(
  edges: Map<string, CanvasEdge>,
  workspaceNodeId: string,
  sandboxNodeId: string,
): void {
  const id = `mount:${workspaceNodeId}-left-${sandboxNodeId}-right`;
  edges.set(id, {
    id: id,
    source: workspaceNodeId,
    target: sandboxNodeId,
    animated: false,
  });
}
