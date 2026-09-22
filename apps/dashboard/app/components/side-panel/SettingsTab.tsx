"use client";

import type { NodeType } from "@/app/components/canvas/nodeTemplates";
import type { CodeOwner } from "@/app/hooks/useNodeOwnership";
import { Button } from "@/app/components/ui/button";

const DELETE_DESCRIPTIONS: Record<
  NodeType,
  { summary: string; detail: string }
> = {
  agent: {
    summary: "Permanently delete this agent and all its data.",
    detail:
      "All sessions, messages, tasks, deployments, and connections for this agent will be deleted forever.",
  },
  mcp: {
    summary: "Delete the MCP server registration.",
    detail:
      "The server row is removed and agents stop registering its tools. An external server itself is untouched.",
  },
  workspace: {
    summary: "Delete this workspace from the stage.",
    detail:
      "The canvas node and its underlying workspaceConfig record are deleted from this stage. Other stages are unaffected, and the persistent files for this workspace become unreachable.",
  },
  sandbox: {
    summary: "Delete this sandbox from the stage.",
    detail:
      "The canvas node and its underlying sandboxConfig record are deleted from this stage. Other stages are unaffected.",
  },
  skill: {
    summary: "Remove this skill from the canvas.",
    detail:
      "The skill is removed from the connected agent's allowed list. The underlying skill definition is not deleted.",
  },
};

/** Danger-zone settings for a canvas node: delete, or why delete is locked. */
export function SettingsTab({
  nodeType,
  onDelete,
  managedByCode = false,
  codeOwner,
  deleteLocked = managedByCode,
}: {
  nodeType: NodeType;
  /** Hands the delete to the canvas, which owns the confirm dialog. */
  onDelete: () => void;
  /** When true, this resource is code-owned (CLI or account API): delete is locked. */
  managedByCode?: boolean;
  /** Which code surface owns the resource; picks the Danger Zone guidance. */
  codeOwner?: CodeOwner;
  /** Blocks delete while ownership is unknown or code owns the resource. */
  deleteLocked?: boolean;
}): React.JSX.Element {
  // A stale stored layout can still carry a retired node type; fall back to
  // generic copy instead of crashing the panel.
  const descriptions = DELETE_DESCRIPTIONS[nodeType] ?? {
    summary: "Remove this node from the canvas.",
    detail: "Only the canvas node is removed.",
  };

  return (
    <div className="flex flex-1 flex-col gap-5 p-4">
      {deleteLocked ? (
        <div className="rounded-lg border border-destructive/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-destructive">
                Danger Zone
              </p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                {managedByCode && codeOwner === "api" ? (
                  <>
                    Managed through the account API. Delete it via{" "}
                    <span className="font-mono">DELETE /v1/…</span> (or the SDK)
                    instead.
                  </>
                ) : managedByCode ? (
                  <>
                    Managed by code in{" "}
                    <span className="font-mono">broods/</span>. Delete it from
                    your code, then run{" "}
                    <span className="font-mono">broods deploy --prune</span>.
                  </>
                ) : (
                  "Checking ownership before delete is available."
                )}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0 cursor-not-allowed text-xs"
              disabled
            >
              Delete
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-destructive/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-destructive">
                Danger Zone
              </p>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                {descriptions.summary}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0 text-xs cursor-pointer"
              onClick={onDelete}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
