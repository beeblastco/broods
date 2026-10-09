"use client";

import { AgentSourceOptions } from "@/app/components/AgentSourceOptions";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";

/**
 * Shown over an empty canvas so the first agent config can be created from it.
 * The footer teaches the shortcuts that open the same list later. While it is
 * up, Add agent focuses this card through `ref` instead of opening the picker.
 */
export function EmptyCanvasGuide({
  onCreateConfig,
  ref,
}: {
  onCreateConfig?: () => void;
  ref?: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div
        ref={ref}
        className="pointer-events-auto flex w-72 flex-col rounded-xl border border-border bg-card/80 p-1 backdrop-blur-md"
      >
        <h3 className="mb-1 mt-3 px-3 text-sm font-medium text-foreground/80">
          Create your first agent service
        </h3>
        <p className="mb-4 px-3 text-xs text-muted-foreground">Pick a source</p>
        <AgentSourceOptions onCreateNew={onCreateConfig} />
        <div className="mt-1 flex items-center gap-1 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
          <span className="mr-auto">Open again with</span>
          <ShortcutKeys id="canvas.addAgent" bordered />
          or
          <ShortcutKeys id="search.open" bordered />
        </div>
      </div>
    </div>
  );
}
