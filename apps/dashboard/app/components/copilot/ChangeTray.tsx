"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
import { StepDetail } from "@/app/components/copilot/CopilotPlanCard";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { Button } from "@/app/components/ui/button";

// Floats over the page, so a change the Broods agent proposed waits in view with the dock closed.
export function ChangeTray(): React.JSX.Element | null {
  const { dismissStep, pending, runStep } = useCopilot();
  if (pending.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <section
        data-change-tray
        aria-label="Changes waiting"
        className="pointer-events-auto flex max-h-80 w-full max-w-xl flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-3 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <BroodsMark className="size-3.5" />
          <span className="text-xs font-medium">
            {pending.length === 1
              ? "1 change waiting"
              : `${pending.length} changes waiting`}
          </span>
          {pending.length > 1 && (
            <Button
              size="xs"
              className="ml-auto"
              onClick={() => {
                for (const change of pending) {
                  runStep(change.messageId, change.index, change.action);
                }
              }}
            >
              Apply all
            </Button>
          )}
        </div>
        {pending.map((change) => (
          <div
            key={`${change.messageId}:${change.index}`}
            data-tray-change
            className="flex flex-col gap-1.5 border-t border-border pt-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">
                {change.action.label}
              </span>
              <Button
                size="xs"
                variant="ghost"
                tone="muted"
                onClick={() => dismissStep(change.messageId, change.index)}
              >
                Discard
              </Button>
              <Button
                size="xs"
                onClick={() =>
                  runStep(change.messageId, change.index, change.action)
                }
              >
                Apply
              </Button>
            </div>
            <StepDetail action={change.action} />
          </div>
        ))}
      </section>
    </div>
  );
}
