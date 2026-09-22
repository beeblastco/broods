"use client";

/**
 * The corner button that opens the copilot dock. It sits bottom-right, out of
 * the header's way and opposite the canvas controls, and steps aside once the
 * dock is open, which carries its own close.
 */
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { Button } from "@/app/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import { MessageSquare } from "lucide-react";

export function CopilotLauncher(): React.JSX.Element | null {
  const { isOpen, setOpen } = useCopilot();

  if (isOpen) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="outline"
              data-copilot-launcher
              className="absolute right-4 bottom-4"
              aria-label="Ask Broods"
              onClick={() => setOpen(true)}
            />
          }
        >
          <MessageSquare />
        </TooltipTrigger>
        <TooltipContent side="left">
          <span className="flex items-center gap-1.5">
            Ask Broods
            <ShortcutKeys id="copilot.open" bordered />
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
