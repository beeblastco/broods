"use client";

import { usePresence } from "@/app/hooks/usePresence";

/**
 * The side panel beside the canvas, as the last children of a `relative flex`
 * row. The canvas gives up and takes back its width in one step; only the
 * panel's content moves. It fades in from the edge on open, and on close it
 * fades out over the canvas, inert, before it hides. Switching nodes keeps it
 * shown, so nothing replays.
 */
export function SidePanelSlot<T>({
  node,
  children,
}: {
  node: T | null;
  children: (node: T | null) => React.ReactNode;
}): React.JSX.Element {
  const panel = usePresence(node);

  return (
    <>
      {node !== null && <div className="h-full w-2/5 shrink-0" />}
      <div
        data-slot="side-panel"
        data-closing={panel.closing ? "" : undefined}
        hidden={panel.value === null}
        inert={panel.closing}
        className="motion-panel absolute inset-y-0 right-0 z-10 w-2/5"
      >
        {children(panel.value)}
      </div>
    </>
  );
}
