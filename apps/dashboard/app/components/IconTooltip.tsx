"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";

/**
 * Wraps an icon-only button: `label` is both its accessible name and its
 * tooltip, as on the canvas controls. The (main) layout's TooltipProvider sets
 * the delay.
 */
export function IconTooltip({
  children,
  label,
}: {
  children: React.ReactElement;
  label: string;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={children} aria-label={label} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
