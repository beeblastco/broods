"use client";

import { Panel } from "@xyflow/react";

// The red is translucent in dark mode: the opaque backing keeps the cards from showing through.
export function CanvasNotice({
  message,
  trailing,
}: {
  message: React.ReactNode;
  trailing: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="pointer-events-auto rounded-lg bg-background shadow-sm">
      <div
        aria-live="polite"
        data-slot="canvas-notice"
        className="flex max-w-xl items-center gap-2 rounded-lg bg-destructive px-2 py-1 text-xs text-white dark:bg-destructive/60"
      >
        <span className="min-w-0">{message}</span>
        {trailing}
      </div>
    </div>
  );
}

export function CanvasPill({
  children,
  slot,
}: {
  children: React.ReactNode;
  slot: string;
}): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      data-slot={slot}
      className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

export function CanvasNoticeHint(): React.JSX.Element {
  return <span className="shrink-0 opacity-80">Release to cancel</span>;
}

// Spans the canvas: React Flow's top-center sits at `left: 50%`, capping a box at half width.
export function CanvasNoticeStrip({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Panel
      position="top-left"
      className="pointer-events-none right-0 flex flex-col items-center gap-1"
    >
      {children}
    </Panel>
  );
}
