/**
 * The active stage's connection for one machine sandbox, by sandbox name:
 * undefined while loading, null when that computer never connected.
 */

import { useStage } from "@/app/hooks/useStage";
import type { MachineConnection } from "@/app/lib/machineConnection";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";

export function useMachineConnection(
  name: string,
): MachineConnection | null | undefined {
  const { projectId } = useParams<{ projectId: string }>();
  const { stageId } = useStage();
  const connections = useQuery(
    api.sandbox.machines.listForActiveOrg,
    projectId && stageId
      ? { projectId: projectId as Id<"projects">, stageId: stageId }
      : "skip",
  );
  if (connections === undefined) return undefined;

  return (
    connections.find((connection): boolean => connection.name === name) ?? null
  );
}
