"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";

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
      <TooltipContent className="max-w-64">{label}</TooltipContent>
    </Tooltip>
  );
}
