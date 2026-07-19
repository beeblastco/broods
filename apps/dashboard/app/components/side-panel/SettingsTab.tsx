"use client";

/** Settings tab with danger zone for node deletion. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Button } from "@/app/components/ui/button";
import { useState } from "react";

type NodeType =
  "agent" | "database" | "tool" | "workspace" | "sandbox" | "skill";

/** Delete warning copy per node type. */
const DELETE_DESCRIPTIONS: Record<
  NodeType,
  { summary: string; detail: string }
> = {
  agent: {
    summary: "Permanently delete this agent and all its data.",
    detail:
      "All sessions, messages, tasks, deployments, and connections for this agent will be deleted forever.",
  },
  database: {
    summary: "Delete the database configuration and all associated data.",
    detail:
      "The database connection config, all auto-populated sessions, and messages from this database will be deleted permanently.",
  },
  tool: {
    summary: "Delete the tool configuration.",
    detail:
      "Only the tool configuration will be removed. This will not interfere with any existing code or tool logic.",
  },
  workspace: {
    summary: "Delete this workspace from the environment.",
    detail:
      "The canvas node and its underlying workspaceConfig record are deleted from this environment. Other environments are unaffected, and the persistent files for this workspace become unreachable.",
  },
  sandbox: {
    summary: "Delete this sandbox from the environment.",
    detail:
      "The canvas node and its underlying sandboxConfig record are deleted from this environment. Other environments are unaffected.",
  },
  skill: {
    summary: "Remove this skill from the canvas.",
    detail:
      "The skill is removed from the connected agent's allowed list. The underlying skill definition is not deleted.",
  },
};

/** Capitalised label for each node type. */
const NODE_TYPE_LABELS: Record<NodeType, string> = {
  agent: "agent",
  database: "database",
  tool: "tool",
  workspace: "workspace",
  sandbox: "sandbox",
  skill: "skill",
};

/** Danger-zone settings for a canvas node: delete, or why delete is locked. */
export function SettingsTab({
  nodeType,
  nodeName,
  openDeleteDialogToken,
  onDelete,
  managedByCode = false,
  codeOwner,
  deleteLocked = managedByCode,
}: {
  nodeType: NodeType;
  nodeName: string;
  openDeleteDialogToken: number;
  onDelete: () => Promise<void>;
  /** When true, this resource is code-owned (CLI or account API): delete is locked. */
  managedByCode?: boolean;
  /** Which code surface owns the resource; picks the Danger Zone guidance. */
  codeOwner?: "cli" | "api";
  /** Blocks delete while ownership is unknown or code owns the resource. */
  deleteLocked?: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [prevDeleteToken, setPrevDeleteToken] = useState(openDeleteDialogToken);

  const descriptions = DELETE_DESCRIPTIONS[nodeType];
  const typeLabel = NODE_TYPE_LABELS[nodeType];

  // Open the delete dialog when the parent bumps the trigger token (handled
  // during render rather than in an effect to avoid a cascading re-render).
  // Locked resources never open it — deletion is blocked.
  if (openDeleteDialogToken !== prevDeleteToken) {
    setPrevDeleteToken(openDeleteDialogToken);
    if (openDeleteDialogToken > 0 && !deleteLocked) {
      setDeleteOpen(true);
    }
  }
  if (deleteOpen && deleteLocked) {
    setDeleteOpen(false);
  }

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await onDelete();
      setDeleteOpen(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <div className="flex flex-1 flex-col gap-5 p-4">
        {deleteLocked ? (
          /* Delete locked: ownership is pending or code owns the resource. */
          <div className="rounded-lg border border-destructive/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-destructive">
                  Danger Zone
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {managedByCode && codeOwner === "api" ? (
                    <>
                      Managed through the account API. Delete it via{" "}
                      <span className="font-mono">DELETE /v1/…</span> (or the
                      SDK) instead.
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
          /* Danger zone */
          <div className="rounded-lg border border-destructive/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-destructive">
                  Danger Zone
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {descriptions.summary}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0 text-xs cursor-pointer"
                onClick={() => setDeleteOpen(true)}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        resourceName={nodeName}
        resourceType={typeLabel}
        critical={false}
        onConfirm={handleDelete}
        isDeleting={isDeleting}
      />
    </>
  );
}
