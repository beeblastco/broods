"use client";

/**
 * A plan, one row per step, with the before and after of anything that writes.
 * The preview is the approval: nothing in the `approval` tier runs until the
 * row's own button is pressed.
 */
import { Button } from "@/app/components/ui/button";
import {
  actionChange,
  actionTier,
  type CopilotAction,
  type CopilotPlan,
} from "@/app/lib/copilotActions";
import { ArrowRight, Ban, Check } from "lucide-react";

export function CopilotPlanCard({
  completed,
  messageId,
  onRun,
  plan,
}: {
  completed: ReadonlySet<string>;
  messageId: string;
  onRun: (index: number, action: CopilotAction) => void;
  plan: CopilotPlan;
}): React.JSX.Element | null {
  if (plan.actions.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
      {plan.actions.map((action, index) => {
        const tier = actionTier(action);
        const change = actionChange(action);
        const isDone = completed.has(`${messageId}:${index}`);

        return (
          <div
            key={`${action.type}-${index}`}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-start gap-2">
              <StepIcon isDone={isDone} tier={tier} />
              <span className="min-w-0 flex-1 text-xs text-foreground">
                {action.label}
              </span>
            </div>

            {change && (
              <div className="ml-5 flex items-center gap-1.5 font-mono text-2xs">
                <span className="text-muted-foreground">{change.field}</span>
                <span className="text-destructive line-through">
                  {change.before}
                </span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="text-success">{change.after}</span>
              </div>
            )}

            {tier === "blocked" && (
              <p className="ml-5 text-2xs text-warning">
                {"reason" in action ? action.reason : null}
              </p>
            )}

            {tier === "approval" && !isDone && (
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

function StepIcon({
  isDone,
  tier,
}: {
  isDone: boolean;
  tier: ReturnType<typeof actionTier>;
}): React.JSX.Element {
  if (tier === "blocked") {
    return <Ban className="mt-0.5 size-3.5 shrink-0 text-warning" />;
  }
  if (isDone) {
    return <Check className="mt-0.5 size-3.5 shrink-0 text-success" />;
  }

  return (
    <span className="mt-1 size-2 shrink-0 rounded-full border border-muted-foreground" />
  );
}
