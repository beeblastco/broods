"use client";

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Button } from "@/app/components/ui/button";
import { useState, type ReactNode } from "react";

export function DangerZone({
  description,
  children,
}: {
  description: string;
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
  resourceType: string;
  onDelete: () => Promise<unknown>;
  onDeleted: () => void;
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
