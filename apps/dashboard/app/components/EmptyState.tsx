import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";

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

export function LockedValue({
  reason = "No permission",
  children,
}: {
  reason?: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default" />}>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Lock className="size-3" aria-label={reason} />
          {children ?? "No permission"}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
