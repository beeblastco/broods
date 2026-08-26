"use client";

/**
 * Context tab (ticket 16 — honest read-only shell; ticket 18 adds folder
 * creation, files, and memory). Shows what is truthfully on the agent's
 * desk today: attached working folders (`config.workspaces`) and its
 * machine (`config.sandbox`), or plain empty states.
 */

import {
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { Folder, HardDrive } from "lucide-react";
import { useMemo } from "react";

interface WorkspaceRef {
  name?: string;
  workspaceId?: string;
}

export function AgentContextTab({
  agentConfig,
}: {
  agentConfig: Doc<"agentConfigs"> | null | undefined;
}): React.JSX.Element {
  const { workspaces, sandbox } = useMemo(() => {
    if (!agentConfig)
      return { workspaces: [] as WorkspaceRef[], sandbox: null };
    const nested = toNestedAgentConfig(
      agentConfig as unknown as FlatAgentConfig,
    ) as Record<string, unknown>;

    return {
      workspaces: Array.isArray(nested.workspaces)
        ? (nested.workspaces as WorkspaceRef[])
        : [],
      sandbox: typeof nested.sandbox === "string" ? nested.sandbox : null,
    };
  }, [agentConfig]);

  if (agentConfig === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">Loading context…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      <div className="flex flex-col gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Working folders
        </span>
        {workspaces.length === 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              The desk is empty. Soon you&apos;ll be able to give this agent a
              working folder here — a place to share files with it and find the
              files it creates.
            </p>
          </div>
        ) : (
          workspaces.map((workspace) => (
            <div
              key={workspace.workspaceId ?? workspace.name}
              className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
            >
              <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-xs font-medium text-foreground">
                  {workspace.name ?? "Unnamed folder"}
                </span>
                {workspace.workspaceId && (
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {workspace.workspaceId}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Machine
        </span>
        {sandbox ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <HardDrive className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-medium text-foreground">
                Sandbox attached
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {sandbox}
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-4">
            <p className="text-xs text-muted-foreground">
              No machine yet. One is set up automatically when this agent gets
              its first working folder.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
