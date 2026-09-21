"use client";

import type { ShownRefusal } from "@/app/components/canvas/useConnectionRefusal";

/**
 * Why the canvas refuses the connection being drawn, at the top of the canvas.
 * While the line is in the air it only explains; once a refused drop lands it
 * stays up with Dismiss, since the line that prompted it is gone.
 */
export function CanvasRefusalNotice({
  refusal,
  onDismiss,
}: {
  refusal: ShownRefusal | null;
  onDismiss: () => void;
}): React.JSX.Element | null {
  if (refusal === null) return null;

  // The red is the destructive button's, translucent in dark mode, so it sits
  // on an opaque backing or the cards under it show through.
  return (
    <div className="rounded-lg bg-background shadow-sm">
      <div
        aria-live="polite"
        data-slot="canvas-refusal"
        className="flex max-w-xl items-center gap-2 rounded-lg bg-destructive px-2 py-1 text-xs text-white dark:bg-destructive/60"
      >
        <span className="min-w-0">{refusal.message}</span>
        {refusal.dropped ? (
          <button
            type="button"
            className="shrink-0 cursor-pointer underline underline-offset-2"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        ) : (
          <span className="shrink-0 opacity-80">Release to cancel</span>
        )}
      </div>
    </div>
  );
}
