"use client";

/** Right-hand detail column shared by the tracing, monitoring, and sandbox
 * tables: a drag handle, header with a close button, scrollable body. Mount it
 * as the last child of a `ResizablePanelGroup` whose first child is the table's
 * `ResizablePanel`; the table shrinks beside it, so the panel never covers the
 * timeline column. Sizes are pixels. */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { ResizableHandle, ResizablePanel } from "@/app/components/ui/resizable";

const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 280;
/** Floor for the table panel beside it, so a wide detail cannot squash the rows away. */
export const TABLE_MIN_WIDTH = 320;

interface Props {
  title: ReactNode;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

export function ObservabilityDetailPanel({
  title,
  meta,
  onClose,
  children,
}: Props): React.JSX.Element {
  return (
    <>
      <ResizableHandle className="cursor-col-resize" />
      <ResizablePanel
        id="detail"
        defaultSize={DEFAULT_WIDTH}
        minSize={MIN_WIDTH}
        className="flex min-h-0 flex-col bg-card"
      >
        <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{title}</div>
            {meta}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      </ResizablePanel>
    </>
  );
}
