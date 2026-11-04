"use client";

import {
  actionTier,
  applyStatus,
  changeKey,
  type CopilotPlan,
  type DockProposal,
} from "@/app/lib/copilotActions";
import { cn } from "@/app/lib/utils";
import { Ban, Check } from "lucide-react";

// Writes live in the canvas bar; the chat keeps the other steps and one status line.
export function CopilotPlanCard({
  completed,
  messageId,
  plan,
  proposal,
  stale = false,
}: {
  completed: ReadonlySet<string>;
  messageId: string;
  plan: CopilotPlan;
  proposal?: DockProposal;
  stale?: boolean;
}): React.JSX.Element | null {
  const steps = plan.actions.flatMap((action, index) =>
    actionTier(action) === "approval" ? [] : [{ action: action, index: index }],
  );
  const status = proposal ? applyStatus(proposal) : null;
  if (steps.length === 0 && !status) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {steps.map(({ action, index }) => (
        <div key={`${action.type}-${index}`} className="flex flex-col gap-0.5">
          <div className="flex items-start gap-1.5">
            {action.type === "blocked" ? (
              <Ban className="mt-0.5 size-3.5 shrink-0 text-warning" />
            ) : completed.has(changeKey(messageId, index)) ? (
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : (
              <span className="mt-1 size-2 shrink-0 rounded-full border border-muted-foreground" />
            )}
            <span data-plan-step className="min-w-0 flex-1 text-xs">
              {action.label}
            </span>
          </div>
          {action.type === "blocked" && (
            <p className="ml-5 text-2xs text-warning">{action.reason}</p>
          )}
        </div>
      ))}
      {proposal && status && (
        <p
          data-apply-status={proposal.apply.phase}
          className={cn(
            "text-2xs",
            proposal.apply.phase === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {stale && proposal.apply.phase === "proposed"
            ? "Asked on another project or stage. Switch back to apply."
            : status}
          {proposal.apply.phase === "deployed" && proposal.apply.runUrl && (
            <>
              {" "}
              <a
                href={proposal.apply.runUrl}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer underline"
              >
                {proposal.apply.finishedAt === undefined
                  ? "Pull request"
                  : "Run"}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
