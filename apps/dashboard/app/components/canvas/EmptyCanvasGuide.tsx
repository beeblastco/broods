"use client";

/** Empty state panel that guides users to create their first agent service. */
import { AgentSourceOptions } from "@/app/components/AgentSourceOptions";

/** Empty state panel that guides users to create their first agent service. */
export function EmptyCanvasGuide({
  onCreateConfig,
}: {
  onCreateConfig?: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="pointer-events-auto flex w-72 flex-col rounded-xl border border-border bg-card/80 p-1 backdrop-blur-md">
        <h3 className="mb-1 mt-3 px-3 text-sm font-medium text-foreground/80">
          Create your first agent service
        </h3>
        <p className="mb-4 px-3 text-xs text-muted-foreground">
          Pick a method to get started
        </p>
        <AgentSourceOptions onCreateNew={onCreateConfig} />
      </div>
    </div>
  );
}
