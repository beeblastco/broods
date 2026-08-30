"use client";

/**
 * Details tab for MCP nodes: name, derived server name, transport, checksum,
 * enabled switch, and the wire to the connected agent's `mcp` config.
 */
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Switch } from "@/app/components/ui/switch";
import { useConnectedAgentConfig } from "@/app/hooks/useConnectedAgentConfig";
import {
  readAgentBranch,
  type FlatAgentConfig,
} from "@/app/lib/agentConfigCodec";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";

export function McpDetailsTab({
  projectId,
  stageId,
  nodeId,
  nodeLabel,
  editName,
  setEditName,
  onSaveName,
  nameChanged,
  isSavingName,
}: {
  projectId: Id<"projects"> | undefined;
  stageId: Id<"stages"> | null;
  nodeId: string;
  nodeLabel: string;
  editName: string;
  setEditName: (name: string) => void;
  onSaveName: () => void;
  nameChanged: boolean;
  isSavingName: boolean;
}): React.JSX.Element {
  const canQuery = !!projectId && !!stageId;
  const server = useQuery(
    api.mcp.getByNode,
    canQuery
      ? { projectId: projectId, stageId: stageId, nodeId: nodeId }
      : "skip",
  );
  const saveForNode = useAction(api.mcp.saveForNode);

  const [isSavingStatus, setIsSavingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const isEnabled = server?.disabled !== true;

  async function handleEnabledChange(nextEnabled: boolean): Promise<void> {
    if (!projectId || !stageId) {
      setStatusError("Select a stage before toggling this server.");

      return;
    }

    setIsSavingStatus(true);
    setStatusError(null);
    try {
      await saveForNode({
        projectId: projectId,
        stageId: stageId,
        nodeId: nodeId,
        nodeLabel: nodeLabel,
        disabled: !nextEnabled,
      });
    } catch (error) {
      setStatusError(toErrorMessage(error));
    } finally {
      setIsSavingStatus(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Name
        </span>
        <div className="flex items-center gap-2">
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveName();
            }}
          />
          {nameChanged && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={!editName.trim() || isSavingName}
              onClick={onSaveName}
            >
              {isSavingName ? "…" : "Save"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Server Name (prefixes every tool as name__tool)
        </span>
        <code className="text-xs text-foreground">
          {server?.name ?? "generated_on_save"}
        </code>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Transport
        </span>
        <code className="text-xs text-foreground">
          {transportLabel(server)}
        </code>
      </div>

      {server?.sha256 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Checksum
          </span>
          <code className="break-all text-xs text-foreground">
            {server.sha256}
          </code>
        </div>
      )}

      <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-foreground">Enabled</span>
          <span className="text-[11px] text-muted-foreground">
            {isEnabled
              ? "Server can register tools on agent runs."
              : "Server is disabled."}
          </span>
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={handleEnabledChange}
          disabled={isSavingStatus || !canQuery || !server}
          aria-label="Toggle MCP server enabled state"
        />
      </div>

      <AgentWireRow nodeId={nodeId} server={server ?? null} />

      {statusError && <p className="text-xs text-destructive">{statusError}</p>}
    </div>
  );
}

/** Agents opt in through their config's `mcp` branch. */
function AgentWireRow({
  nodeId,
  server,
}: {
  nodeId: string;
  server: Doc<"mcp"> | null;
}): React.JSX.Element {
  const { agentConfig, updateBranch } = useConnectedAgentConfig(nodeId);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const branch = readAgentBranch<Record<string, { enabled?: boolean }>>(
    agentConfig as FlatAgentConfig | undefined,
    "mcp",
  );
  const enabledOnAgent = !!server && branch[server._id]?.enabled === true;

  async function handleChange(nextEnabled: boolean): Promise<void> {
    if (!server) return;

    setIsSaving(true);
    setError(null);
    try {
      const next: Record<string, { enabled?: boolean }> = { ...branch };
      if (nextEnabled) {
        next[server._id] = { enabled: true };
      } else {
        delete next[server._id];
      }
      await updateBranch(
        ["mcp"],
        Object.keys(next).length > 0 ? next : undefined,
      );
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium text-foreground">
            Enabled on connected agent
          </span>
          <span className="text-[11px] text-muted-foreground">
            {agentConfig
              ? "Writes mcp into the wired agent's config."
              : "Wire this node to an agent first."}
          </span>
        </div>
        <Switch
          checked={enabledOnAgent}
          onCheckedChange={handleChange}
          disabled={isSaving || !agentConfig || !server}
          aria-label="Toggle server on the connected agent"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}

function transportLabel(server: Doc<"mcp"> | null | undefined): string {
  if (!server) return "set in the Server tab";

  return server.transport === "hosted"
    ? "hosted (Node bundle on the tool runner)"
    : `external (${server.url ?? ""})`;
}
