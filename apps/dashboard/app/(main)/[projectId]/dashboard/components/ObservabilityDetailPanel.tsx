"use client";

/** Right-hand detail column shared by the tracing and monitoring tables: fixed
 * width, header with a close button, scrollable body. The table shrinks beside
 * it (split layout), so the panel never covers the timeline column. */
import { X } from "lucide-react";
import type { ReactNode } from "react";

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
    <aside className="flex w-90 min-h-0 shrink-0 flex-col border-l border-border bg-card">
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
    </aside>
  );
}
