"use client";

import { AgentSourceOptions } from "@/app/components/AgentSourceOptions";

/** Shown over an empty canvas so the first agent config can be created from it. */
export function EmptyCanvasGuide({
  onCreateConfig,
}: {
  onCreateConfig?: () => void;
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="pointer-events-auto flex w-72 flex-col rounded-xl border border-border bg-card/80 p-1 backdrop-blur-md">
        <h3 className="mb-1 mt-3 px-3 text-sm font-medium text-foreground/80">
          Create your first agent service
        </h3>
        <p className="mb-4 px-3 text-xs text-muted-foreground">Pick a source</p>
        <AgentSourceOptions onCreateNew={onCreateConfig} />
      </div>
    </div>
  );
}
