"use client";

/** Dialog for selecting how a new tool should be created. */
import { ToolSourceOptions } from "@/app/components/ToolSourceOptions";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";

/** Dialog for selecting the source of a new tool service. */
export function ToolSourcePickerDialog({
    open,
    onOpenChange,
    onSelect,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (source: "docker" | "upload" | "scratch") => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xs p-1 gap-0">
                <DialogHeader className="px-3 pt-3 pb-1">
                    <DialogTitle className="text-sm font-medium text-foreground/80">
                        Add tool
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                        Select how to create the tool
                    </DialogDescription>
                </DialogHeader>
                <ToolSourceOptions
                    onSelect={(source) => {
                        onOpenChange(false);
                        onSelect(source);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}
