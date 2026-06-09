"use client";

/** Displays the top header bar with logo, project selector, environment selector, navigation links, and user menu. */
import { OrgSwitcher } from "@/app/components/header/OrgSwitcher";
import { UserMenu } from "@/app/components/UserMenu";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";

// Split project-only controls into separate chunks.
const ProjectHeaderLeft = dynamic(
    () => import("@/app/components/header/ProjectHeaderLeft").then((mod) => mod.ProjectHeaderLeft),
    { loading: () => <div className="flex items-center gap-3 h-4" /> },
);
const ProjectHeaderRight = dynamic(
    () => import("@/app/components/header/ProjectHeaderRight").then((mod) => mod.ProjectHeaderRight),
    { loading: () => <div className="flex items-center gap-1 h-4" /> },
);

export function Header() {
    const params = useParams<{ projectId?: string }>();
    const isProjectPage = Boolean(params.projectId);
    const { resolvedTheme } = useTheme();

    return (
        <header className="flex h-12 shrink-0 items-center border-b border-border">
            <div className="flex w-full items-center gap-3 px-5">
                <Link
                    href={isProjectPage ? `/${params.projectId}` : "/"}
                    className="hover:opacity-80 transition-opacity cursor-pointer"
                >
                    {resolvedTheme === "dark" ? (
                        <Image src="/assets/logo/dark-full.svg" alt="Logo" width={277} height={64} className="h-7 w-auto" />
                    ) : (
                        <Image src="/assets/logo/light-full.svg" alt="Logo" width={278} height={64} className="h-7 w-auto" />
                    )}
                </Link>

                <div className="h-4 w-px bg-border" />
                <OrgSwitcher />

                <ProjectHeaderLeft />

                <div className="ml-auto flex items-center gap-3 h-4">
                    {isProjectPage && <ProjectHeaderRight />}
                    <UserMenu />
                </div>
            </div>
        </header>
    );
}
