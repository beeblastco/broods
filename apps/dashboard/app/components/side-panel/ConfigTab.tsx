"use client";

/**
 * Single JSON editor for the nested AgentConfig, with the branches in
 * `CONFIG_TAB_BRANCHES` merged into one object. `session` holds context
 * pruning and compaction.
 */
import { BranchEditor } from "@/app/components/side-panel/BranchEditor";
import {
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMemo } from "react";

/** Branches the Config tab edits; saving replaces exactly these and keeps the rest. */
export const CONFIG_TAB_BRANCHES = [
  "agent",
  "model",
  "provider",
  "session",
] as const;

export function ConfigTab({
  agentConfig,
  onSave,
}: {
  agentConfig:
    | (FlatAgentConfig & { _id?: Id<"agentConfigs"> })
    | null
    | undefined;
  onSave: (value: unknown) => Promise<void>;
}): React.JSX.Element {
  const configValue = useMemo(() => {
    if (!agentConfig) return {};
    const n = toNestedAgentConfig(agentConfig) as Record<string, unknown>;

    return Object.fromEntries(
      CONFIG_TAB_BRANCHES.filter((branch) => n[branch] !== undefined).map(
        (branch) => [branch, n[branch]],
      ),
    );
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
