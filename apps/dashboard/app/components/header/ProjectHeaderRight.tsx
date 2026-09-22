"use client";

import { CommandMenu } from "@/app/components/CommandMenu";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { NavLinks } from "@/app/components/NavLinks";
import { useShortcutRegistry } from "@/app/components/ShortcutProvider";
import { Button } from "@/app/components/ui/button";
import { formatCombo } from "@/app/lib/shortcuts";
import { Sparkles } from "lucide-react";

export function ProjectHeaderRight(): React.JSX.Element {
  const { isOpen, setOpen } = useCopilot();
  const { isMac } = useShortcutRegistry();

  return (
    <>
      <NavLinks />
      <div className="h-4 w-px bg-border" />
      <CommandMenu />
      <Button
        size="xs"
        variant="nav"
        data-active={isOpen}
        onClick={() => setOpen(!isOpen)}
        title={`Ask Broods (${formatCombo("mod+j", isMac).join("")})`}
      >
        <Sparkles className="text-canvas-agent" />
        Ask
      </Button>
    </>
  );
}
