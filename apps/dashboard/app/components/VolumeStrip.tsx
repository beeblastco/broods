"use client";

import { BarStrip, type StripBar } from "@/app/components/BarStrip";
import { formatDateTime, formatTime } from "@/app/lib/formatTime";
import type { TimeWindow, VolumeBin } from "@/app/lib/queryTokens";
import { useRef, useState } from "react";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Props {
  bins: VolumeBin[];
  /** The window the bins cover; the strip draws it edge to edge. */
  window: TimeWindow;
  /** The part of the window the list is narrowed to, or null for all of it. */
  selection: TimeWindow | null;
  onSelect: (selection: TimeWindow | null) => void;
  /** A time to mark with a red line, such as the selected trace's start. */
  marker?: number;
}

/**
 * Volume per bin under the toolbar, error and warn share tinted. Dragging
 * across it narrows the list to those bins; a click on the strip outside a
 * selection clears it. The whole window reads at the right edge. A marker
 * inside the window draws as a red line.
 */
export function VolumeStrip({
  bins,
  window,
  selection,
  onSelect,
  marker,
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

  const bars = bins.map((bin): StripBar => {
    const inSelection =
      shown !== null &&
      bin.start + span / bins.length > shown.from &&
      bin.start < shown.to;

    return {
      key: bin.start,
      height: bin.total / max,
      tone:
        bin.error > 0
          ? "bg-destructive/70"
          : bin.warn > 0
            ? "bg-warning/60"
            : "bg-muted",
      dimmed: shown !== null && !inSelection,
    };
  });

  return (
    <BarStrip
      ref={strip}
      bars={bars}
      label={`${label}${selection && !drag ? " · click to reset" : ""}`}
      className="cursor-crosshair"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
      title="Drag to narrow the time window"
    >
      {shown && (
        <span
          style={{
            "--sel-left": `${((shown.from - window.from) / span) * 100}%`,
            "--sel-right": `${((window.to - shown.to) / span) * 100}%`,
          }}
          className="pointer-events-none absolute inset-y-0 left-(--sel-left) right-(--sel-right) border-x border-info bg-info/10"
        />
      )}
      {marker !== undefined && marker >= window.from && marker <= window.to && (
        <span
          style={{
            "--marker-left": `${((marker - window.from) / span) * 100}%`,
          }}
          className="pointer-events-none absolute inset-y-0 left-(--marker-left) w-px bg-destructive"
        />
      )}
    </BarStrip>
  );
}
