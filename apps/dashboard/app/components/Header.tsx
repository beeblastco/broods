"use client";

/** Displays the top header bar with logo, project selector, environment selector, navigation links, and user menu. */
import { UserMenu } from "@/app/components/UserMenu";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

// Split project-only controls into separate chunks.
const ProjectHeaderLeft = dynamic(
    () => import("@/app/components/header/ProjectHeaderLeft").then((mod) => mod.ProjectHeaderLeft),
);
const ProjectHeaderRight = dynamic(
    () => import("@/app/components/header/ProjectHeaderRight").then((mod) => mod.ProjectHeaderRight),
);

export function Header() {
    const params = useParams<{ projectId?: string }>();
    const isProjectPage = Boolean(params.projectId);

    return (
        <header className={`flex h-12 shrink-0 items-center border-b ${isProjectPage ? "border-border" : "border-transparent"}`}>
            <div className={`flex w-full items-center gap-3 ${isProjectPage ? "px-5" : "mx-auto max-w-5xl"}`}>
                <Link href="/" className="text-base font-bold text-foreground hover:opacity-80 transition-opacity">Clonee</Link>

                {isProjectPage && <ProjectHeaderLeft />}

                <div className="ml-auto flex items-center gap-3 h-4">
                    {isProjectPage && <ProjectHeaderRight />}
                    <UserMenu />
                </div>
            </div>
        </header>
    );
}
