"use client";

import { BroodsMark } from "@/app/components/BroodsMark";
import { CommandMenu } from "@/app/components/CommandMenu";
import { useCopilot } from "@/app/components/copilot/CopilotProvider";
import { OrgSwitcher } from "@/app/components/header/OrgSwitcher";
import { ProjectHeaderLeft } from "@/app/components/header/ProjectHeaderLeft";
import { ShortcutKeys } from "@/app/components/ShortcutKeys";
import { Button } from "@/app/components/ui/button";
import { useSidebar } from "@/app/components/ui/sidebar";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Lock } from "lucide-react";

// Not lazy: the stage selector lives here, and every page's first query waits on its stage.

export function Header(): React.JSX.Element {
  const { role } = useOrgRole();
  const { toggleSidebar } = useSidebar();

  // px-3 and the size-6 mark put the logo's circle on the sidebar icons' axis.
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-3 border-b border-border px-3">
      <button
        type="button"
        aria-label="Toggle sidebar"
        data-sidebar="trigger"
        onClick={toggleSidebar}
        draggable={false}
        className="shrink-0 cursor-pointer transition-opacity hover:opacity-80"
      >
        <BroodsMark className="size-6" />
      </button>

      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
        <div className="h-4 w-px shrink-0 bg-border" />
        <OrgSwitcher />
        {role === "member" && (
          <span
            className="flex shrink-0 select-none items-center gap-1 text-2xs text-warning/90"
            title="Members read everything and change nothing. Ask an org admin for changes."
          >
            <Lock className="size-3" />
            read-only
          </span>
        )}

        <ProjectHeaderLeft />
      </div>

      <CommandMenu />
      <AgentButton />
    </header>
  );
}

function AgentButton(): React.JSX.Element {
  const { isOpen, setOpen } = useCopilot();

  return (
    <Button
      variant="nav"
      size="sm"
      data-active={isOpen}
      aria-pressed={isOpen}
      aria-label="Broods agent"
      onClick={() => setOpen(!isOpen)}
      className="h-6.5 shrink-0 select-none cursor-pointer"
    >
      <BroodsMark className="size-3.5" />
      <span className="hidden lg:inline">Agent</span>
      <ShortcutKeys id="copilot.open" className="hidden lg:flex" />
    </Button>
  );
}
