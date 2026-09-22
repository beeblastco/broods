"use client";

import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { useStage } from "@/app/hooks/useStage";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useParams } from "next/navigation";

/** Who owns a resource, as the ownership query reports it. */
export type ResourceOwner = FunctionReturnType<
  typeof api.canvas.resourceOwnership
>[string];

/** The two owners the dashboard must not write over. */
export type CodeOwner = Exclude<ResourceOwner, "dashboard">;

export type NodeOwnership = {
  /** The card's agent config, for an agent card whose config has loaded. */
  agentConfig: AgentConfig;
  /** Which code surface owns the card, or `undefined` when the dashboard does. */
  codeOwner: CodeOwner | undefined;
  isCodeManaged: boolean;
  /** True while the owning record is still in flight: treat the card as locked. */
  isOwnershipLoading: boolean;
};

type AgentConfig =
  | FunctionReturnType<typeof api.agent.config.getById>
  | undefined;

/** Where a card's authoritative `managedBy` lives. */
type OwnershipKind = "agent" | "resource" | "canvas";

type ResourceOwnership =
  | FunctionReturnType<typeof api.canvas.resourceOwnership>
  | undefined;

/**
 * Who owns one canvas card, for every surface that has to refuse an edit code
 * owns. Agents read the authoritative `managedBy` from their config row;
 * workspaces and sandboxes read it from the live `resourceOwnership` query keyed
 * by the row `_id` (the node's `resourceId`), not the cached `managedBy` on
 * canvas node data which can be stale or missing. Falls back to the cached value
 * while the query loads. A code-managed card cannot be deleted here, and a
 * sandbox's config reads as read-only: the canvas save leaves those rows
 * untouched, so an edit would never persist.
 */
export function useNodeOwnership(node: Node | null): NodeOwnership {
  const { stageId } = useStage();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const nodeData = node?.data as BaseNodeData | undefined;
  const kind = ownershipKind(node);
  const agentConfigId = nodeData?.agentConfigId as
    | Id<"agentConfigs">
    | undefined;

  const agentConfig = useQuery(
    api.agent.config.getById,
    agentConfigId && kind === "agent" ? { configId: agentConfigId } : "skip",
  );
  const resourceOwnership = useQuery(
    api.canvas.resourceOwnership,
    projectId && stageId && kind === "resource"
      ? { projectId: projectId, stageId: stageId }
      : "skip",
  );

  return {
    agentConfig: agentConfig,
    ...resolveOwnership({
      agentConfig: agentConfig,
      agentConfigId: agentConfigId,
      kind: kind,
      nodeData: nodeData,
      resourceOwnership: resourceOwnership,
    }),
  };
}

/** The owner and how far along reading it is, once both queries have reported. */
function resolveOwnership({
  agentConfig,
  agentConfigId,
  kind,
  nodeData,
  resourceOwnership,
}: {
  agentConfig: AgentConfig;
  agentConfigId: Id<"agentConfigs"> | undefined;
  kind: OwnershipKind;
  nodeData: BaseNodeData | undefined;
  resourceOwnership: ResourceOwnership;
}): Omit<NodeOwnership, "agentConfig"> {
  const resourceId = nodeData?.resourceId;
  const live =
    kind === "agent"
      ? agentConfig?.managedBy
      : resourceId
        ? resourceOwnership?.[resourceId]
        : undefined;
  const owner = live ?? nodeData?.managedBy;
  const codeOwner = owner === "cli" || owner === "api" ? owner : undefined;
  const pending =
    kind === "agent"
      ? !!agentConfigId && agentConfig === undefined
      : kind === "resource" && !!resourceId && resourceOwnership === undefined;

  return {
    codeOwner: codeOwner,
    isCodeManaged: codeOwner !== undefined,
    isOwnershipLoading: pending,
  };
}

/** Which record carries this card's `managedBy`. */
function ownershipKind(node: Node | null): OwnershipKind {
  if (node?.type === "agent") return "agent";
  if (node?.type === "workspace" || node?.type === "sandbox") {
    return "resource";
  }

  return "canvas";
}
