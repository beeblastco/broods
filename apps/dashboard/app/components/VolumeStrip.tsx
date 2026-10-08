"use client";

import { formatDateTime, formatTime } from "@/app/lib/formatTime";
import type { TimeWindow, VolumeBin } from "@/app/lib/queryTokens";
import { cn } from "@/app/lib/utils";
import { useRef, useState } from "react";

const DAY_MS = 24 * 60 * 60 * 1000;
// The tallest bar stops here, so the window label above it stays readable.
const BAR_MAX_PERCENT = 70;

interface Props {
  bins: VolumeBin[];
  /** The window the bins cover; the strip draws it edge to edge. */
  window: TimeWindow;
  /** The part of the window the list is narrowed to, or null for all of it. */
  selection: TimeWindow | null;
  onSelect: (selection: TimeWindow | null) => void;
}

/**
 * Volume per bin under the toolbar, error and warn share tinted. Dragging
 * across it narrows the list to those bins; a click on the strip outside a
 * selection clears it. The whole window reads at the right edge.
 */
export function VolumeStrip({
  bins,
  window,
  selection,
  onSelect,
}: Props): React.JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const max = Math.max(1, ...bins.map((bin) => bin.total));
  const span = Math.max(1, window.to - window.from);

  const msAt = (clientX: number): number => {
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width === 0) return window.from;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));

    return window.from + ratio * span;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = msAt(event.clientX);
    setDrag({ from: at, to: at });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag) setDrag({ from: drag.from, to: msAt(event.clientX) });
  };

  const onPointerUp = (): void => {
    if (!drag) return;
    setDrag(null);
    const from = Math.min(drag.from, drag.to);
    const to = Math.max(drag.from, drag.to);
    // Shorter than a bin is a click: it clears the selection.
    onSelect(to - from < span / bins.length ? null : { from: from, to: to });
  };

  // A selection may be open-ended or reach past the strip; draw its visible part.
  const shown = drag
    ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) }
    : selection && {
        from: Math.max(selection.from, window.from),
        to: Math.min(selection.to, window.to),
      };
  // Clock times alone read the same at both ends of a multi-day window.
  const formatEdge = span >= DAY_MS ? formatDateTime : formatTime;
  const labelled = shown ?? window;
  const label = `${formatEdge(labelled.from)} → ${formatEdge(labelled.to)}`;

  return (
    <div
      ref={strip}
      className="relative flex h-9 shrink-0 cursor-crosshair items-end gap-px border-b border-border pt-1 select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      title="Drag to narrow the time window"
    >
      {bins.map((bin) => {
        const inSelection =
          shown !== null &&
          bin.start + span / bins.length > shown.from &&
          bin.start < shown.to;
        const tone =
          bin.error > 0
            ? "bg-destructive/70"
            : bin.warn > 0
              ? "bg-warning/60"
              : "bg-muted";

        return (
          <span
            key={bin.start}
            style={{
              "--bar-height": `${(bin.total / max) * BAR_MAX_PERCENT}%`,
            }}
            className={cn(
              "h-(--bar-height) min-h-px flex-1",
              tone,
              shown !== null && !inSelection && "opacity-30",
            )}
          />
        );
      })}
      {shown && (
        <span
          style={{
            "--sel-left": `${((shown.from - window.from) / span) * 100}%`,
            "--sel-right": `${((window.to - shown.to) / span) * 100}%`,
          }}
          className="pointer-events-none absolute inset-y-0 left-(--sel-left) right-(--sel-right) border-x border-info bg-info/10"
        />
      )}
      {/* The window ends at the client's clock, which the server render cannot know. */}
      <span
        suppressHydrationWarning
        className="pointer-events-none absolute top-0 right-3 font-mono text-3xs text-muted-foreground"
      >
        {label}
        {selection && !drag && " · click to reset"}
      </span>
    </div>
  );
}
