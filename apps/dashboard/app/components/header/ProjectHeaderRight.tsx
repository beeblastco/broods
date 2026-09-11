"use client";

import { CommandMenu } from "@/app/components/CommandMenu";
import { NavLinks } from "@/app/components/NavLinks";

export function ProjectHeaderRight(): React.JSX.Element {
  return (
    <>
      <NavLinks />
      <div className="h-4 w-px bg-border" />
      <CommandMenu />
    </>
  );
}
