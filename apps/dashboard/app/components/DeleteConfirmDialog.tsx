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
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { toErrorMessage } from "@/app/lib/errors";
import { type FormEvent, useState } from "react";

export const CRITICAL_SAFETY_PHRASE =
  "I understand that it will delete all data and can't undo";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name of the resource being deleted (used as 'delete <resourceName>'). */
  resourceName: string;
  /** Shown in the dialog title as 'Delete <resourceType>'. */
  resourceType: string;
  /** When true, the confirmation phrase includes an extra irreversible-delete acknowledgement. */
  critical?: boolean;
  /** Called only when all required inputs match. A rejection shows under the input. */
  onConfirm: () => Promise<void>;
  isDeleting?: boolean;
  /** The verb the title, the phrase and the button use when it is not Delete: "Remove" for a member. */
  verb?: string;
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
  verb = "Delete",
}: Props): React.JSX.Element {
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const deletePhrase = critical
    ? `${verb.toLowerCase()} ${resourceName}, ${CRITICAL_SAFETY_PHRASE}`
    : `${verb.toLowerCase()} ${resourceName}`;
  const canConfirm = phrase === deletePhrase && !isDeleting;

  function handleOpenChange(next: boolean): void {
    if (!next) {
      setPhrase("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!canConfirm) return;
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {verb} {resourceType}
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone. Type the following to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="delete-confirm-primary">Confirmation text</Label>
              <div
                className="select-text whitespace-pre-wrap wrap-break-word rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm leading-6 text-foreground"
                aria-label="Text to type for delete confirmation"
              >
                {deletePhrase}
              </div>
              <Input
                id="delete-confirm-primary"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder={deletePhrase}
                autoFocus
                autoComplete="off"
              />
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={() => handleOpenChange(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className="cursor-pointer"
              disabled={!canConfirm}
            >
              {isDeleting ? `${verb.replace(/e$/, "")}ing…` : verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
