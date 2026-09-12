"use client";

/** Top header bar, rendered once by the signed-in layout. */
import { BroodsLogo } from "@/app/components/BroodsLogo";
import { OrgSwitcher } from "@/app/components/header/OrgSwitcher";
import { ProjectHeaderLeft } from "@/app/components/header/ProjectHeaderLeft";
import { ProjectHeaderRight } from "@/app/components/header/ProjectHeaderRight";
import { UserMenu } from "@/app/components/UserMenu";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Lock } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

// Shipped with the header, not behind a second request: the stage selector
// lives here, and every page's first query waits on the stage it picks.

export function Header(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const isProjectPage = Boolean(params.projectId);
  const { role } = useOrgRole();

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-border">
      <div className="flex w-full items-center gap-3 px-5">
        <Link
          href={isProjectPage ? `/${params.projectId}` : "/"}
          aria-label="Broods"
          draggable={false}
          className="hover:opacity-80 transition-opacity cursor-pointer"
        >
          <BroodsLogo className="h-7 w-auto" />
        </Link>

        <div className="h-4 w-px bg-border" />
        <OrgSwitcher />
        {role === "member" && (
          <span
            className="flex select-none items-center gap-1 text-[11px] text-amber-500/90"
            title="Members read everything and change nothing. Ask an org admin for changes."
          >
            <Lock className="size-3" />
            read-only
          </span>
        )}

        <ProjectHeaderLeft />

        <div className="ml-auto flex items-center gap-3 h-4">
          {isProjectPage && <ProjectHeaderRight />}
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
