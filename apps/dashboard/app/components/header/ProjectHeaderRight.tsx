"use client";

import { CommandMenu } from "@/app/components/CommandMenu";
import { NavLinks } from "@/app/components/NavLinks";

/**
 * Search first, then the page tabs, then the avatar the header adds after us:
 * you pick where you are going before you pick what to do there.
 */
export function ProjectHeaderRight(): React.JSX.Element {
  return (
    <>
      <CommandMenu />
      <div className="h-4 w-px bg-border" />
      <NavLinks />
    </>
  );
}
