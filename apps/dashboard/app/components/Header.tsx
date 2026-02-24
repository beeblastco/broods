"use client";

import { CommandMenu } from "@/app/components/CommandMenu";
import { UserMenu } from "@/app/components/UserMenu";

/** Displays the top header bar with logo text, workspace label, and user menu. */
export function Header() {
    return (
        <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-5 py-2.5">
            <span className="text-base font-bold text-white">Clonee</span>
            <div className="h-4 w-px bg-white/10" />
            <span className="text-sm font-medium text-white/70">My Workspace</span>

            <div className="ml-auto flex items-center gap-3">
                <CommandMenu />
                <UserMenu />
            </div>
        </header>
    );
}
