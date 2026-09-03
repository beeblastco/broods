"use client";

/** Displays the top header bar with logo, project selector, stage selector, navigation links, and user menu. */
import { OrgSwitcher } from "@/app/components/header/OrgSwitcher";
import { Skeleton } from "@/app/components/ui/skeleton";
import { UserMenu } from "@/app/components/UserMenu";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { Lock } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";

// Split project-only controls into separate chunks.
const ProjectHeaderLeft = dynamic(
  () =>
    import("@/app/components/header/ProjectHeaderLeft").then(
      (mod) => mod.ProjectHeaderLeft,
    ),
  {
    // Mirrors the divider + selector this chunk resolves to, so the left side
    // of the header lands in one place instead of snapping wider.
    loading: () => (
      <div className="flex items-center gap-3 h-4">
        <div className="h-4 w-px bg-border" />
        <Skeleton className="h-4 w-24 bg-muted" />
      </div>
    ),
  },
);
const ProjectHeaderRight = dynamic(
  () =>
    import("@/app/components/header/ProjectHeaderRight").then(
      (mod) => mod.ProjectHeaderRight,
    ),
  { loading: () => <div className="flex items-center gap-1 h-4" /> },
);

export function Header(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const isProjectPage = Boolean(params.projectId);
  const { resolvedTheme } = useTheme();
  const { role } = useOrgRole();

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-border">
      <div className="flex w-full items-center gap-3 px-5">
        <Link
          href={isProjectPage ? `/${params.projectId}` : "/"}
          className="hover:opacity-80 transition-opacity cursor-pointer"
        >
          {resolvedTheme === "dark" ? (
            <Image
              src="/assets/logo/dark-broods-full.svg"
              alt="Broods"
              width={232}
              height={64}
              className="h-7 w-auto"
            />
          ) : (
            <Image
              src="/assets/logo/light-broods-full.svg"
              alt="Broods"
              width={232}
              height={64}
              className="h-7 w-auto"
            />
          )}
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
