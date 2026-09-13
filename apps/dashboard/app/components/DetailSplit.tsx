"use client";

/**
 * The table-plus-detail split the monitoring, tracing, and sandbox tables
 * share: the table on the left, an optional detail column on the right with a
 * drag handle between them.
 */
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/app/components/ui/resizable";
import {
  DETAIL_DEFAULT_WIDTH,
  DETAIL_MIN_WIDTH,
  TABLE_MIN_WIDTH,
} from "@/app/lib/detailSplit";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface DetailPanelProps {
  title: ReactNode;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

interface DetailSplitProps {
  /** The table. Scrolls on its own inside the left panel. */
  children: ReactNode;
  /** The detail column's content, or nothing while no row is selected. */
  detail: ReactNode;
}

/** The detail column's header with a close button, then a scrollable body. */
export function DetailPanel({
  title,
  meta,
  onClose,
  children,
}: DetailPanelProps): React.JSX.Element {
  return (
    <>
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
    </>
  );
}

export function DetailSplit({
  children,
  detail,
}: DetailSplitProps): React.JSX.Element {
  return (
    <ResizablePanelGroup className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
      <ResizablePanel
        minSize={TABLE_MIN_WIDTH}
        className="min-h-0 min-w-0 overflow-auto"
      >
        {children}
      </ResizablePanel>
      {detail && (
        <>
          <ResizableHandle className="cursor-col-resize" />
          <ResizablePanel
            defaultSize={DETAIL_DEFAULT_WIDTH}
            minSize={DETAIL_MIN_WIDTH}
            className="flex min-h-0 flex-col bg-card"
          >
            {detail}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
