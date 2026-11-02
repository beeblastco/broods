"use client";

import { usePresence } from "@/app/hooks/usePresence";

/**
 * Last children of a `relative flex` row. The width snaps; only the content fades, and on
 * close it fades out over the canvas, inert, before it hides.
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
