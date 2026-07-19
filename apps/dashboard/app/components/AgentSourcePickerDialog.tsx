"use client";

/** Dialog for selecting where an agent config should be sourced from. */
import { AgentSourceOptions } from "@/app/components/AgentSourceOptions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";

/** Dialog for selecting the source of a new agent configuration. */
export function AgentSourcePickerDialog({
  open,
  onOpenChange,
  onCreateNew,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateNew: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs p-1 gap-0">
        <DialogHeader className="px-3 pt-3 pb-1">
          <DialogTitle className="text-sm font-medium text-foreground/80">
            Add agent
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Select where the config should come from
          </DialogDescription>
        </DialogHeader>
        <AgentSourceOptions
          onCreateNew={() => {
            onOpenChange(false);
            onCreateNew();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
