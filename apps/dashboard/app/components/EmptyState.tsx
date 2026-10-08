import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What an empty list says: one line, an optional second in muted text, and
 * at most one action. No card around it, so it reads the same inside a
 * table frame and on a bare page.
 */
export function EmptyState({
  title,
  detail,
  action,
  icon,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <p className="text-sm text-foreground">{title}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A whole page or list the viewer may not see: one lock and the permission to ask for. */
export function NoPermission({
  permission,
  scope,
}: {
  permission: string;
  scope: string;
}): React.JSX.Element {
  return (
    <EmptyState
      icon={<Lock className="size-5" />}
      title="No permission"
      detail={`Ask an owner for ${permission} on ${scope}.`}
    />
  );
}

/** A cell, field or value the viewer may not read: a lock with the reason on hover. */
export function LockedValue({
  reason = "No permission",
  children,
}: {
  reason?: string;
  /** What shows beside the lock; the plain value when it may be seen but not changed. */
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex cursor-default items-center gap-1.5 text-muted-foreground" />
        }
      >
        <Lock className="size-3" aria-label={reason} />
        {children ?? "No permission"}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
