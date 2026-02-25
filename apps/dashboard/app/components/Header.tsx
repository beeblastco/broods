"use client";

/** Displays the top header bar with logo, project selector, environment selector, navigation links, and user menu. */
import { CommandMenu } from "@/app/components/CommandMenu";
import { EnvironmentSelector } from "@/app/components/EnvironmentSelector";
import { NavLinks } from "@/app/components/NavLinks";
import { ProjectSelector } from "@/app/components/ProjectSelector";
import { UserMenu } from "@/app/components/UserMenu";
import Link from "next/link";
import { useParams } from "next/navigation";

export function Header() {
    const params = useParams<{ projectId?: string }>();
    const isProjectPage = Boolean(params.projectId);

    return (
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-2.5">
            <Link href="/" className="text-base font-bold text-foreground hover:opacity-80 transition-opacity">Clonee</Link>

            {isProjectPage && (
                <>
                    <div className="h-4 w-px bg-border" />
                    <ProjectSelector />
                    <div className="h-4 w-px bg-border" />
                    <EnvironmentSelector />
                </>
            )}

            <div className="ml-auto flex items-center gap-3">
                <NavLinks />
                <div className="h-4 w-px bg-border" />
                <CommandMenu />
                <UserMenu />
            </div>
        </header>
    );
}
