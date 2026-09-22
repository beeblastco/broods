"use client";

import { Panel } from "@xyflow/react";

/**
 * Something the canvas has to say and the user did not ask for: a refused
 * connection, a refused drop, a save that failed. Render inside
 * {@link CanvasNoticeStrip}.
 *
 * The red is the destructive button's, translucent in dark mode, so it sits on
 * an opaque backing or the cards under it show through.
 */
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

/** What a notice ends with while the thing it is about is still held. */
export function CanvasNoticeHint(): React.JSX.Element {
  return <span className="shrink-0 opacity-80">Release to cancel</span>;
}

/**
 * The one place a canvas notice appears: centred at the top, so a refused
 * connection and a failed save are read in the same spot instead of one corner
 * each.
 *
 * The panel spans the canvas and centres its children rather than using React
 * Flow's own top-center, which sits at `left: 50%` and so caps a shrink-to-fit
 * box at half the canvas, wrapping a sentence that has room. The strip takes no
 * clicks, only the boxes in it do.
 */
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
