"use client";

import type { AgentProvider } from "@/app/components/side-panel/DetailsTab";
import { useLatestRef } from "@/app/hooks/useLatestRef";
import { useReachableAgentConfigId } from "@/app/hooks/useReachableAgentConfigId";
import {
  fromNestedAgentConfig,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { applyAgentConfigUpdate } from "@/app/lib/agentConfigOptimistic";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useRef } from "react";

export interface ConnectedAgentConfig {
  agentConfigId: Id<"agentConfigs"> | undefined;
  agentConfig: Doc<"agentConfigs"> | null | undefined;
  updateBranch: (path: ReadonlyArray<string>, value: unknown) => Promise<void>;
}

export function useConnectedAgentConfig(
  nodeId: string | undefined,
  via?: ReadonlyArray<string>,
): ConnectedAgentConfig {
  const agentConfigId = useReachableAgentConfigId(nodeId, via);

  const agentConfig = useQuery(
    api.agent.config.getById,
    agentConfigId ? { configId: agentConfigId } : "skip",
  );
  const updateConfig = useMutation(
    api.agent.config.update,
  ).withOptimisticUpdate(applyAgentConfigUpdate);

  // Writes queue on the freshest config: each re-projects the whole config, so one built on
  // a stale reactive snapshot would undo the edit before it.
  const config = agentConfig as FlatAgentConfig | undefined;
  const latestConfig = useRef<FlatAgentConfig | null | undefined>(config);
  useLatestRef(latestConfig, config);
  const writeChain = useRef<Promise<void>>(Promise.resolve());

  const updateBranch = useCallback(
    (path: ReadonlyArray<string>, value: unknown) => {
      if (!agentConfigId || path.length === 0) {
        return writeChain.current;
      }

      const run = async (): Promise<void> => {
        const base = latestConfig.current;
        if (!base) {
          return;
        }

        // toNestedAgentConfig returns branches by reference into the Convex-cached document.
        const nested = structuredClone(toNestedAgentConfig(base));
        let cursor: Record<string, unknown> = nested as Record<string, unknown>;
        for (let i = 0; i < path.length - 1; i += 1) {
          const key = path[i];
          const next = cursor[key];
          if (
            typeof next !== "object" ||
            next === null ||
            Array.isArray(next)
          ) {
            cursor[key] = {};
          }
          cursor = cursor[key] as Record<string, unknown>;
        }
        const leaf = path[path.length - 1];
        if (value === undefined) {
          delete cursor[leaf];
        } else {
          cursor[leaf] = value;
        }

        const patch = fromNestedAgentConfig(nested);
        latestConfig.current = { ...base, ...patch };
        const { provider, ...rest } = patch;
        await updateConfig({
          configId: agentConfigId,
          ...rest,
          provider: provider as AgentProvider | undefined,
        });
      };

      writeChain.current = writeChain.current.then(run, run);

      return writeChain.current;
    },
    [agentConfigId, updateConfig],
  );

  return {
    agentConfigId: agentConfigId,
    agentConfig: agentConfig,
    updateBranch: updateBranch,
  };
}
