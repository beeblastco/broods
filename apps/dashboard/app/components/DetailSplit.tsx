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
import { cn } from "@/app/lib/utils";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface DetailPanelProps {
  title: ReactNode;
  meta?: ReactNode;
  /** Buttons on the title line, between the title and the close button. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

interface DetailSplitProps {
  /** The table. Scrolls on its own inside the left panel. */
  children: ReactNode;
  /** The detail column's content, or nothing while no row is selected. */
  detail: ReactNode;
  /** Drop the card frame, for a panel that fills the page edge to edge. */
  flush?: boolean;
  /** The table panel's narrowest width, for tables wider than the default. */
  tableMinWidth?: number;
}

/**
 * The detail column's header with a close button, then a scrollable body.
 * With `actions` and no `meta` the header is one centered line, the same
 * height as the toolbar over the table.
 */
export function DetailPanel({
  title,
  meta,
  actions,
  onClose,
  children,
}: DetailPanelProps): React.JSX.Element {
  return (
    <>
      <div
        className={cn(
          "flex justify-between gap-2 border-b border-border/60 px-3 py-2",
          actions && !meta ? "items-center" : "items-start",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{title}</div>
          {meta}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        )}
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
  flush = false,
  tableMinWidth = TABLE_MIN_WIDTH,
}: DetailSplitProps): React.JSX.Element {
  return (
    <ResizablePanelGroup
      className={cn(
        "min-h-0 flex-1 overflow-hidden bg-card",
        !flush && "rounded-lg border border-border",
      )}
    >
      <ResizablePanel
        minSize={tableMinWidth}
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
