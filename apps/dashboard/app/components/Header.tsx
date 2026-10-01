"use client";

/** Top header bar above the sidebar, rendered once by the signed-in layout. */
import { BroodsLogo } from "@/app/components/BroodsLogo";
import { CommandMenu } from "@/app/components/CommandMenu";
import { OrgSwitcher } from "@/app/components/header/OrgSwitcher";
import { ProjectHeaderLeft } from "@/app/components/header/ProjectHeaderLeft";
import { useSidebar } from "@/app/components/ui/sidebar";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Lock } from "lucide-react";
import { useParams } from "next/navigation";

// Shipped with the header, not behind a second request: the stage selector
// lives here, and every page's first query waits on the stage it picks.

export function Header(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const { role } = useOrgRole();
  const { toggleSidebar } = useSidebar();

  // px-3 and the h-6 mark put the logo's circle on the sidebar icons' axis.
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-3 border-b border-border px-3">
      <button
        type="button"
        aria-label="Toggle sidebar"
        onClick={toggleSidebar}
        draggable={false}
        className="cursor-pointer transition-opacity hover:opacity-80"
      >
        <BroodsLogo className="h-6 w-auto" />
      </button>

      <div className="h-4 w-px bg-border" />
      <OrgSwitcher />
      {role === "member" && (
        <span
          className="flex select-none items-center gap-1 text-2xs text-warning/90"
          title="Members read everything and change nothing. Ask an org admin for changes."
        >
          <Lock className="size-3" />
          read-only
        </span>
      )}

      <ProjectHeaderLeft />

      {params.projectId && (
        <div className="ml-auto">
          <CommandMenu />
        </div>
      )}
    </header>
  );
}
