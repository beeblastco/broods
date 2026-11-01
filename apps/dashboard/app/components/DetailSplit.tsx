"use client";

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
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

interface DetailSplitProps {
  children: ReactNode;
  detail: ReactNode;
  flush?: boolean;
  tableMinWidth?: number;
}

export function DetailPanel({
  title,
  meta,
  actions,
  onClose,
  children,
}: DetailPanelProps): React.JSX.Element {
  return (
    <>
      <div className="border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-xs font-medium">
            {title}
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
        {meta}
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
  const frame = cn(
    "relative min-h-0 flex-1 overflow-hidden bg-card",
    !flush && "rounded-lg border border-border",
    // On a phone the table stays laid out under the open detail, so closing keeps its
    // scroll; CSS only, so nothing remounts across widths.
    detail &&
      "max-md:[&>[data-panel]:first-child]:invisible max-md:[&>[data-panel]:first-child]:absolute max-md:[&>[data-panel]:first-child]:inset-0",
  );

  return (
    <ResizablePanelGroup className={frame}>
      <ResizablePanel
        minSize={tableMinWidth}
        className="min-h-0 min-w-0 overflow-auto"
      >
        {children}
      </ResizablePanel>
      {detail && (
        <>
          <ResizableHandle className="max-md:hidden" />
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
