"use client";

import { CanvasNotice, CanvasPill } from "@/app/components/canvas/CanvasNotice";
import { useTimeoutFlag } from "@/app/hooks/useTimeoutFlag";

const SAVED_PILL_MS = 2_000;

export type CanvasSaveState = "idle" | "pending" | "saving" | "saved" | "error";

export function CanvasSaveStatus({
  state,
  message,
  onRetry,
}: {
  state: CanvasSaveState;
  message?: string | null;
  onRetry: () => void;
}): React.JSX.Element | null {
  const saved = useTimeoutFlag(state === "saved" ? state : null, SAVED_PILL_MS);

  if (
    state === "idle" ||
    state === "pending" ||
    (state === "saved" && saved === null)
  ) {
    return null;
  }

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
