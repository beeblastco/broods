"use client";

/** Reusable typed-confirm delete dialog. Critical deletes merge the resource name and safety phrase into one input. */
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

export const CRITICAL_SAFETY_PHRASE =
  "I understand that it will delete all data and can't undo";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name of the resource being deleted (used as 'delete <resourceName>'). */
  resourceName: string;
  /** Shown in the dialog title as 'Delete <resourceType>'. */
  resourceType: string;
  /** When true, a second confirmation input is required with the fixed safety phrase. */
  critical?: boolean;
  /** Called only when all required inputs match. Must return a promise. */
  onConfirm: () => Promise<void>;
  isDeleting?: boolean;
}

/** Typed-confirm delete dialog. Shows 'Delete <resourceType>' as title; requires typing
 * 'delete <resourceName>' (and, when critical, the safety phrase) before enabling confirm. */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  resourceName,
  resourceType,
  critical = false,
  onConfirm,
  isDeleting = false,
}: Props) {
  const [phrase, setPhrase] = useState("");
  const deletePhrase = critical
    ? `delete ${resourceName}, ${CRITICAL_SAFETY_PHRASE}`
    : `delete ${resourceName}`;
  const canConfirm = phrase === deletePhrase && !isDeleting;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPhrase("");
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (!canConfirm) return;
    await onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {resourceType}</DialogTitle>
          <DialogDescription>
            This action cannot be undone. Type the following to confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="delete-confirm-primary">
              <span>Type </span>
              <span className="font-mono font-medium text-foreground break-all">
                {deletePhrase}
              </span>
              <span> to confirm</span>
            </Label>
            <Input
              id="delete-confirm-primary"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={deletePhrase}
              autoFocus
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="cursor-pointer"
            onClick={() => handleOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="cursor-pointer disabled:cursor-not-allowed"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {isDeleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
