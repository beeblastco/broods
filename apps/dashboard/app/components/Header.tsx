"use client";

/** Displays the top header bar with logo, project selector, navigation links, and user menu. */
import { CommandMenu } from "@/app/components/CommandMenu";
import { NavLinks } from "@/app/components/NavLinks";
import { ProjectSelector } from "@/app/components/ProjectSelector";
import { UserMenu } from "@/app/components/UserMenu";

export function Header() {
    return (
        <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-5 py-2.5">
            <span className="text-base font-bold text-white">Clonee</span>
            <div className="h-4 w-px bg-white/10" />
            <ProjectSelector />

            <div className="ml-auto flex items-center gap-3">
                <NavLinks />
                <div className="h-4 w-px bg-white/10" />
                <CommandMenu />
                <UserMenu />
            </div>
        </header>
    );
}
