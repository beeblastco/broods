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
