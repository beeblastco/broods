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
        <header className={`flex h-12 shrink-0 items-center border-b ${isProjectPage ? "border-border" : "border-transparent"}`}>
            <div className={`flex w-full items-center gap-3 ${isProjectPage ? "px-5" : "mx-auto max-w-5xl"}`}>
                <Link href="/" className="text-base font-bold text-foreground hover:opacity-80 transition-opacity">Clonee</Link>

                {isProjectPage && (
                    <>
                        <div className="h-4 w-px bg-border" />
                        <ProjectSelector />
                        <div className="h-4 w-px bg-border" />
                        <EnvironmentSelector />
                    </>
                )}

                <div className="ml-auto flex items-center gap-3 h-4">
                    {isProjectPage && (
                        <>
                            <NavLinks />
                            <div className="h-4 w-px bg-border" />
                            <CommandMenu />
                        </>
                    )}
                    <UserMenu />
                </div>
            </div>
        </header>
    );
}
