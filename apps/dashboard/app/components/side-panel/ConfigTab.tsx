"use client";

/**
 * Agent Config tab — single JSON editor for the full nested AgentConfig
 * (`agent`, `model`, `provider` branches merged into one object).
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import {
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMemo } from "react";

export function ConfigTab({
  agentConfig,
  onSave,
}: {
  agentConfig:
    | (FlatAgentConfig & { _id?: Id<"agentConfigs"> })
    | null
    | undefined;
  onSave: (value: unknown) => Promise<void>;
}) {
  const configValue = useMemo(() => {
    if (!agentConfig) return {};
    const n = toNestedAgentConfig(agentConfig) as Record<string, unknown>;

    return {
      ...(n.agent !== undefined ? { agent: n.agent } : {}),
      ...(n.model !== undefined ? { model: n.model } : {}),
      ...(n.provider !== undefined ? { provider: n.provider } : {}),
    };
  }, [agentConfig]);

  if (!agentConfig) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-center text-xs text-muted-foreground">
          Loading agent configuration…
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
      <BranchEditor title="Config" value={configValue} onSave={onSave} />
    </div>
  );
}
