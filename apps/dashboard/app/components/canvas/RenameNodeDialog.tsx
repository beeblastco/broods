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
import { useState } from "react";

/**
 * Rename one canvas card from its right-click menu. Key it on the card, so the
 * field starts on that card's name rather than the last one renamed. The label
 * is canvas text: what an agent's workspace or sandbox is called in its refs is
 * its mount name, which the side panel owns.
 */
export function RenameNodeDialog({
  label,
  nodeId,
  open,
  onOpenChange,
  onRename,
}: {
  label: string;
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (nodeId: string, label: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState(label);
  const trimmed = name.trim();

  function handleRename(): void {
    if (trimmed === "" || trimmed === label) {
      onOpenChange(false);

      return;
    }
    onRename(nodeId, trimmed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename card</DialogTitle>
          <DialogDescription>
            What this card is called on the canvas.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleRename();
          }}
        >
          <div className="grid gap-3 py-4">
            <Label htmlFor="rename-node-name">Name</Label>
            <Input
              id="rename-node-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="cursor-pointer disabled:cursor-not-allowed"
              disabled={trimmed === ""}
            >
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
