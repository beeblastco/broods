"use client";

import { useShortcut } from "@/app/components/ShortcutProvider";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { RefreshCw } from "lucide-react";

/**
 * The bar above every list. Slots read left to right: search, facets, range,
 * count and refresh, then the page's one primary action. Pages compose the
 * slots they need and keep the order.
 */
export function Toolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 select-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** "128 / 2,310": rows shown of rows held. Sits right before the refresh button. */
export function ToolbarCount({
  shown,
  total,
}: {
  shown: number;
  total: number;
}): React.JSX.Element {
  return (
    <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
      {shown === total
        ? total.toLocaleString()
        : `${shown.toLocaleString()} / ${total.toLocaleString()}`}
    </span>
  );
}

/** The refresh button, bound to the `r` shortcut; a failed stream turns it red. */
export function RefreshButton({
  onRefresh,
  disabled,
  title,
  isError,
}: {
  onRefresh: () => void;
  disabled: boolean;
  title: string;
  isError: boolean;
}): React.JSX.Element {
  useShortcut("table.refresh", () => !disabled && onRefresh());

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      onClick={onRefresh}
      disabled={disabled}
      aria-label="Refresh"
      title={title}
      tone={isError ? "destructive" : "muted"}
      className="cursor-pointer"
    >
      <RefreshCw className="size-3.5" />
    </Button>
  );
}
