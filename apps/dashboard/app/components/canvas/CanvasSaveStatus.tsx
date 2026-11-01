"use client";

import { CanvasNotice, CanvasPill } from "@/app/components/canvas/CanvasNotice";
import { useEffect, useState } from "react";

const SAVED_PILL_MS = 2_000;

export type CanvasSaveState = "idle" | "saving" | "saved" | "error";

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
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    setSavedShown(state === "saved");
  }

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- timer that hides the Saved pill
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
    <CanvasPill slot="canvas-save-pill">
      {state === "saving" ? "Saving…" : "Saved"}
    </CanvasPill>
  );
}
