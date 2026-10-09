/**
 * The active stage's connection for one machine sandbox, by sandbox name:
 * undefined while loading, null when that computer never connected.
 */

import { useStage } from "@/app/hooks/useStage";
import type { MachineConnection } from "@/app/lib/machineConnection";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";

export function useMachineConnection(
  name: string,
): MachineConnection | null | undefined {
  const { stageArgs } = useStage();
  const connections = useQuery(
    api.sandbox.machines.listForActiveOrg,
    stageArgs,
  );
  if (connections === undefined) return undefined;

  return (
    connections.find((connection): boolean => connection.name === name) ?? null
  );
}
