"use client";

import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";

/**
 * One question before an action that cannot be taken back without a cost:
 * rotate a key, suspend a sandbox, pay for a seat. The verb is the button,
 * destructive unless the action only costs money; a typed phrase is
 * `DeleteConfirmDialog`'s job.
 */
export function ConfirmDialog({
  title,
  description,
  verb,
  variant = "destructive",
  pending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  /** The button's word, and with "…" the word while it runs. */
  verb: string;
  variant?: "default" | "destructive";
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant={variant}
            size="sm"
            className="cursor-pointer"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? `${verb}…` : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
