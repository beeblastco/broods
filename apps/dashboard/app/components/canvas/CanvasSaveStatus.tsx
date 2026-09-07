"use client";

import { useEffect, useState } from "react";

// How long "Saved" stays up before the pill clears. Without it the pill was
// permanent from the first save on.
const SAVED_PILL_MS = 2_000;

export type CanvasSaveState = "idle" | "saving" | "saved" | "error";

/**
 * The canvas autosave pill. "Saving…" and a failed save stay up as long as
 * they hold; "Saved" clears itself after a moment, and comes back for the
 * next save because that passes through "saving" first.
 */
export function CanvasSaveStatus({
  state,
  onRetry,
}: {
  state: CanvasSaveState;
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

  return (
    <div
      aria-live="polite"
      className="rounded-lg border border-border bg-card/80 px-2 py-1 text-xs backdrop-blur-md"
    >
      {state === "saving" && (
        <span className="text-muted-foreground">Saving…</span>
      )}
      {state === "saved" && (
        <span className="text-muted-foreground">Saved</span>
      )}
      {state === "error" && (
        <span className="flex items-center gap-2 text-destructive">
          Couldn&apos;t save
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2"
            onClick={onRetry}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  );
}
