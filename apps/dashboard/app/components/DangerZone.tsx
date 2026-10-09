"use client";

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Button } from "@/app/components/ui/button";
import { useState, type ReactNode } from "react";

/**
 * The red-bordered block at the end of a detail panel for the one action
 * that cannot be undone: a heading, one line on what it does, the button.
 */
export function DangerZone({
  description,
  children,
}: {
  description: string;
  /** The destructive button. */
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/**
 * The danger zone whose one action is deleting the panel's resource: the
 * button, the typed-confirm dialog, and the pending state. The dialog shows
 * the mutation's rejection under its input; once the mutation resolves the
 * dialog closes and `onDeleted` runs, usually closing the panel.
 */
export function DeleteZone({
  description,
  resourceName,
  resourceType,
  onDelete,
  onDeleted,
  verb = "Delete",
  disabled = false,
}: {
  description: string;
  resourceName: string;
  /** The noun the dialog names: "role", "scheduler". */
  resourceType: string;
  onDelete: () => Promise<unknown>;
  onDeleted: () => void;
  /** The button's and the dialog's word when it is not Delete: "Remove", "Terminate". */
  verb?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm(): Promise<void> {
    setPending(true);
    try {
      await onDelete();
    } finally {
      setPending(false);
    }
    setConfirming(false);
    onDeleted();
  }

  return (
    <DangerZone description={description}>
      <Button
        variant="destructive"
        size="sm"
        className="cursor-pointer"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        {verb}
      </Button>
      {confirming && (
        <DeleteConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          resourceName={resourceName}
          resourceType={resourceType}
          critical={false}
          onConfirm={confirm}
          isDeleting={pending}
          verb={verb}
        />
      )}
    </DangerZone>
  );
}
