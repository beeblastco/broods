"use client";

import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { useStage } from "@/app/hooks/useStage";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { Node } from "@xyflow/react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useParams } from "next/navigation";

export type ResourceOwner = FunctionReturnType<
  typeof api.canvas.resourceOwnership
>[string];

export type CodeOwner = Exclude<ResourceOwner, "dashboard">;

export type NodeOwnership = {
  agentConfig: AgentConfig;
  codeOwner: CodeOwner | undefined;
  isCodeManaged: boolean;
  /** Treat the card as locked while this is true. */
  isOwnershipLoading: boolean;
};

type AgentConfig =
  | FunctionReturnType<typeof api.agent.config.getById>
  | undefined;

type OwnershipKind = "agent" | "resource" | "canvas";

type ResourceOwnership =
  | FunctionReturnType<typeof api.canvas.resourceOwnership>
  | undefined;

// The live `managedBy` wins over the copy on canvas node data, which can be stale or missing.
// Code-managed rows are read-only here: the canvas save leaves them untouched.
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

function ownershipKind(node: Node | null): OwnershipKind {
  if (node?.type === "agent") return "agent";
  if (node?.type === "workspace" || node?.type === "sandbox") {
    return "resource";
  }

  return "canvas";
}
