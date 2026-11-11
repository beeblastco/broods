"use client";

import {
  DETAIL_DEFAULT_WIDTH,
  DETAIL_MIN_WIDTH,
  TABLE_MIN_WIDTH,
} from "@/app/lib/detailSplit";
import { cn } from "@/app/lib/utils";
import { X } from "lucide-react";
import { observeResize } from "@/app/lib/observeResize";
import { useCallback, useRef, useState, type ReactNode } from "react";

const HANDLE_WIDTH_PX = 1;
const KEY_STEP_PX = 16;

// The separator's keys, as the detail width they move to; the detail is the primary pane.
const KEY_MOVES: Partial<Record<string, (width: number) => number>> = {
  ArrowLeft: (width) => width + KEY_STEP_PX,
  ArrowRight: (width) => width - KEY_STEP_PX,
  End: () => Infinity,
  Home: () => DETAIL_MIN_WIDTH,
};

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

// The table flexes above its floor; the detail keeps its width and shrinks only to its minimum.
export function DetailSplit({
  children,
  detail,
  flush = false,
  tableMinWidth = TABLE_MIN_WIDTH,
}: DetailSplitProps): React.JSX.Element {
  const drag = useRef<number | null>(null);
  const [width, setWidth] = useState(DETAIL_DEFAULT_WIDTH);
  const [frameWidth, setFrameWidth] = useState(0);
  if (!detail && width !== DETAIL_DEFAULT_WIDTH) setWidth(DETAIL_DEFAULT_WIDTH);
  const measure = useCallback(
    (el: HTMLDivElement | null) =>
      el ? observeResize(el, () => setFrameWidth(el.clientWidth)) : undefined,
    [],
  );
  const room = Math.max(
    DETAIL_MIN_WIDTH,
    frameWidth - HANDLE_WIDTH_PX - tableMinWidth,
  );

  const shown = Math.min(width, room);
  const resize = (next: number): void =>
    setWidth(Math.max(DETAIL_MIN_WIDTH, Math.min(next, room)));

  return (
    <div
      ref={measure}
      data-slot="resizable-panel-group"
      style={{
        "--detail-min": `${DETAIL_MIN_WIDTH}px`,
        "--detail-width": `${width}px`,
        "--table-min": `${tableMinWidth}px`,
      }}
      className={cn(
        "@container/split relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-card has-[>[data-slot=resizable-handle]:active]:cursor-col-resize has-[>[data-slot=resizable-handle]:active]:**:cursor-col-resize",
        !flush && "rounded-lg border border-border",
      )}
    >
      <div
        data-slot="resizable-panel"
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-auto",
          // Too narrow for both, the table stays laid out under the open detail, so closing keeps
          // its scroll; CSS only, so nothing remounts across widths.
          detail &&
            "min-w-(--table-min) @max-2xl/split:invisible @max-2xl/split:absolute @max-2xl/split:inset-0",
        )}
      >
        {children}
      </div>
      {detail && (
        <>
          <div
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable splitter; lint bars handlers on an hr
            role="separator"
            aria-label="Resize details"
            aria-orientation="vertical"
            aria-valuemax={room}
            aria-valuemin={DETAIL_MIN_WIDTH}
            aria-valuenow={shown}
            tabIndex={0}
            data-slot="resizable-handle"
            onKeyDown={(event) => {
              const move = KEY_MOVES[event.key];
              if (!move) return;
              event.preventDefault();
              resize(move(shown));
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = event.clientX + shown;
            }}
            onPointerMove={(event) => {
              if (drag.current !== null) resize(drag.current - event.clientX);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            className="relative w-px shrink-0 cursor-col-resize bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-2.5 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden @max-2xl/split:hidden"
          />
          <div
            data-slot="resizable-panel"
            className="flex min-h-0 min-w-(--detail-min) shrink basis-(--detail-width) flex-col overflow-hidden bg-card @max-2xl/split:grow"
          >
            {detail}
          </div>
        </>
      )}
    </div>
  );
}
