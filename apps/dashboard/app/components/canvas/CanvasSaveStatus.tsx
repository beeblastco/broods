"use client";

import { CanvasNotice } from "@/app/components/canvas/CanvasNotice";
import { useEffect, useState } from "react";

// How long "Saved" stays up before the pill clears. Without it the pill was
// permanent from the first save on.
const SAVED_PILL_MS = 2_000;

export type CanvasSaveState = "idle" | "saving" | "saved" | "error";

/**
 * The canvas autosave pill, in the canvas's notice strip. "Saving…" and a
 * failed save stay up as long as they hold; "Saved" clears itself after a
 * moment, and comes back for the next save because that passes through
 * "saving" first. A failure says why when the save reported a reason, and
 * wears the same red box as a refused connection so every canvas error reads
 * the same way in the same place.
 */
export function CanvasSaveStatus({
  state,
  message,
  onRetry,
}: {
  state: CanvasSaveState;
  message?: string | null;
  onRetry: () => void;
}): React.JSX.Element | null {
  const [savedShown, setSavedShown] = useState(false);
  // Render-time adjust: a fresh "saved" shows at once; the timer below hides it.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    setSavedShown(state === "saved");
  }

  useEffect(() => {
    if (state !== "saved") return;
    const timer = setTimeout(() => setSavedShown(false), SAVED_PILL_MS);

    return () => clearTimeout(timer);
  }, [state]);

  if (state === "idle" || (state === "saved" && !savedShown)) return null;

  if (state === "error") {
    return (
      <CanvasNotice
        message={<>Couldn&apos;t save{message ? `: ${message}` : ""}</>}
        trailing={
          <button
            type="button"
            className="shrink-0 cursor-pointer underline underline-offset-2"
            onClick={onRetry}
          >
            Retry
          </button>
        }
      />
    );
  }

  return (
    <div
      aria-live="polite"
      data-slot="canvas-save-pill"
      className="pointer-events-auto rounded-lg border border-border bg-card/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur-md"
    >
      {state === "saving" ? "Saving…" : "Saved"}
    </div>
  );
}
