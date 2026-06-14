"use client";

/** Settings tab with danger zone for node deletion. */
import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";

type NodeType =
  | "agent"
  | "database"
  | "tool"
  | "workspace"
  | "sandbox"
  | "skill";

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

export function SettingsTab({
  nodeType,
  nodeName,
  openDeleteDialogToken,
  onDelete,
  managedByCode = false,
  deleteLocked = managedByCode,
}: {
  nodeType: NodeType;
  nodeName: string;
  openDeleteDialogToken: number;
  onDelete: () => Promise<void>;
  /** When true, this resource is owned by a filthypanty/ project: delete is locked. */
  managedByCode?: boolean;
  /** Blocks delete while ownership is unknown or code owns the resource. */
  deleteLocked?: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [prevDeleteToken, setPrevDeleteToken] = useState(openDeleteDialogToken);

  const deletePhrase = `delete ${nodeName}`;
  const descriptions = DELETE_DESCRIPTIONS[nodeType];
  const typeLabel = NODE_TYPE_LABELS[nodeType];

  // Open the delete dialog when the parent bumps the trigger token (handled
  // during render rather than in an effect to avoid a cascading re-render).
  // Locked resources never open it — deletion is blocked.
  if (openDeleteDialogToken !== prevDeleteToken) {
    setPrevDeleteToken(openDeleteDialogToken);
    if (openDeleteDialogToken > 0 && !deleteLocked) {
      setConfirmPhrase("");
      setDeleteOpen(true);
    }
  }
  if (deleteOpen && deleteLocked) {
    setDeleteOpen(false);
    setConfirmPhrase("");
  }

  async function handleDelete() {
    if (confirmPhrase !== deletePhrase) return;
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
                  {managedByCode ? (
                    <>
                      Managed by code in{" "}
                      <span className="font-mono">filthypanty/</span>. Delete it
                      from your code, then run{" "}
                      <span className="font-mono">
                        filthy-panty deploy --prune
                      </span>.
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
                className="shrink-0 text-xs"
                onClick={() => {
                  setConfirmPhrase("");
                  setDeleteOpen(true);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteOpen(false);
            setConfirmPhrase("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {typeLabel}</DialogTitle>
            <DialogDescription asChild>
              <div className="grid gap-3 text-sm text-muted-foreground">
                <p>
                  This will permanently delete{" "}
                  <span className="font-semibold text-foreground">
                    {nodeName}
                  </span>{" "}
                  and cannot be undone.
                </p>
                <p>{descriptions.detail}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <Label htmlFor="confirm-delete-node" className="grid gap-1">
              <span>Type the following to confirm</span>
              <span className="font-mono font-medium text-foreground break-all">
                {deletePhrase}
              </span>
            </Label>
            <Input
              id="confirm-delete-node"
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              placeholder={deletePhrase}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDeleteOpen(false);
                setConfirmPhrase("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmPhrase !== deletePhrase || isDeleting}
              onClick={handleDelete}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
