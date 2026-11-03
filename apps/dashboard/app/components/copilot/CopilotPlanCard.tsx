"use client";

import { Button } from "@/app/components/ui/button";
import {
  actionChange,
  actionTier,
  type CopilotAction,
  type CopilotPlan,
} from "@/app/lib/copilotActions";
import { ArrowRight, Ban, Check, X } from "lucide-react";

// The preview is the approval: an `approval`-tier step runs only from its own button.
export function CopilotPlanCard({
  completed,
  dismissed,
  messageId,
  onRun,
  plan,
  stale = false,
}: {
  completed: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  messageId: string;
  onRun: (index: number, action: CopilotAction) => void;
  plan: CopilotPlan;
  stale?: boolean;
}): React.JSX.Element | null {
  if (plan.actions.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
      {plan.actions.map((action, index) => {
        const key = `${messageId}:${index}`;
        const tier = actionTier(action);
        const isDone = completed.has(key);
        const isDismissed = dismissed.has(key);
        const waiting = tier === "approval" && !isDone && !isDismissed;

        return (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- plan steps never reorder
            key={`${action.type}-${index}`}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-start gap-2">
              <StepIcon isDismissed={isDismissed} isDone={isDone} tier={tier} />
              <span
                data-plan-step
                className={
                  isDismissed
                    ? "min-w-0 flex-1 text-xs text-muted-foreground line-through"
                    : "min-w-0 flex-1 text-xs text-foreground"
                }
              >
                {action.label}
              </span>
            </div>

            <StepDetail action={action} />

            {waiting && stale && (
              <p className="ml-5 text-2xs text-muted-foreground">
                Asked on another project or stage. Switch back to apply.
              </p>
            )}

            {waiting && !stale && (
              <div className="ml-5">
                <Button size="xs" onClick={() => onRun(index, action)}>
                  Apply
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** What a step will change: the field's before and after, the reason it is refused, its diff. */
export function StepDetail({
  action,
}: {
  action: CopilotAction;
}): React.JSX.Element {
  const change = actionChange(action);

  return (
    <>
      {change && (
        <div
          data-plan-change
          className="ml-5 flex flex-wrap items-center gap-1.5 font-mono text-2xs"
        >
          <span className="text-muted-foreground">{change.field}</span>
          <span className="text-destructive line-through">{change.before}</span>
          <ArrowRight className="size-3 text-muted-foreground" />
          <span className="text-success">{change.after}</span>
        </div>
      )}

      {action.type === "commitFiles" &&
        action.files.map((file) => (
          <details key={file.path} open className="ml-5 text-2xs">
            <summary className="cursor-pointer font-mono text-muted-foreground">
              {file.path}{" "}
              <span className="text-success">
                +{file.patch.filter((line) => line.startsWith("+")).length}
              </span>{" "}
              <span className="text-destructive">
                -{file.patch.filter((line) => line.startsWith("-")).length}
              </span>
            </summary>
            <pre
              data-plan-diff
              className="mt-1 max-h-60 overflow-auto rounded-sm border border-border p-2 font-mono text-2xs"
            >
              {file.patch.map((line, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- a patch never reorders
                <div key={index} className={diffLineClass(line)}>
                  {line}
                </div>
              ))}
            </pre>
          </details>
        ))}

      {action.type === "blocked" && (
        <p className="ml-5 text-2xs text-warning">{action.reason}</p>
      )}
    </>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+")) return "text-success";
  if (line.startsWith("-")) return "text-destructive";

  return "text-muted-foreground";
}

function StepIcon({
  isDismissed,
  isDone,
  tier,
}: {
  isDismissed: boolean;
  isDone: boolean;
  tier: ReturnType<typeof actionTier>;
}): React.JSX.Element {
  if (tier === "blocked") {
    return <Ban className="mt-0.5 size-3.5 shrink-0 text-warning" />;
  }
  if (isDismissed) {
    return <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (isDone) {
    return <Check className="mt-0.5 size-3.5 shrink-0 text-success" />;
  }

  return (
    <span className="mt-1 size-2 shrink-0 rounded-full border border-muted-foreground" />
  );
}
