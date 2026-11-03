"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
import { StepDetail } from "@/app/components/copilot/CopilotPlanCard";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { Button } from "@/app/components/ui/button";
import type { TrackedDeploy } from "@/app/lib/copilotActions";
import { Check, X } from "lucide-react";

const DEPLOY_TEXT: Record<TrackedDeploy["state"], string> = {
  deployed: "Deployed",
  deploying: "Deploying",
  failed: "Deploy failed",
  waiting: "Committed",
};

// Floats over the page: changes waiting for Apply, then each applied commit until it deploys.
export function ChangeTray(): React.JSX.Element | null {
  const { deploys, dismissDeploy, dismissStep, pending, runStep } =
    useCopilot();
  if (pending.length === 0 && deploys.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <section
        data-change-tray
        aria-label="Changes waiting"
        className="pointer-events-auto flex max-h-96 w-full max-w-xl flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-popover p-3 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <BroodsMark className="size-3.5" />
          <span className="text-xs font-medium">{heading(pending.length)}</span>
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
        {deploys.map((deploy) => (
          <div
            key={deploy.sha}
            data-tray-deploy={deploy.state}
            className="flex items-center gap-2 border-t border-border pt-2 text-xs"
          >
            <DeployIcon state={deploy.state} />
            <span className="min-w-0 flex-1 truncate">{deploy.label}</span>
            <span className="text-2xs text-muted-foreground">
              {DEPLOY_TEXT[deploy.state]}
            </span>
            <a
              href={deploy.runUrl ?? deploy.url}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer text-2xs underline"
            >
              {deploy.runUrl ? "Run" : "Commit"}
            </a>
            {(deploy.state === "deployed" || deploy.state === "failed") && (
              <Button
                size="xs"
                variant="ghost"
                tone="muted"
                onClick={() => dismissDeploy(deploy.sha)}
              >
                Dismiss
              </Button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

function DeployIcon({
  state,
}: {
  state: TrackedDeploy["state"];
}): React.JSX.Element {
  if (state === "deployed") {
    return <Check className="size-3.5 shrink-0 text-success" />;
  }
  if (state === "failed") {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }

  return (
    <span className="size-2 shrink-0 rounded-full border border-muted-foreground" />
  );
}

function heading(waiting: number): string {
  if (waiting === 0) return "Applied";

  return waiting === 1 ? "1 change waiting" : `${waiting} changes waiting`;
}
