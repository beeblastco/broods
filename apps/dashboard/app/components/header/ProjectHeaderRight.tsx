"use client";

import { CommandMenu } from "@/app/components/CommandMenu";
import { NavLinks } from "@/app/components/NavLinks";

/** Project navigation/actions shown on the right side of the header. */
export function ProjectHeaderRight() {
  return (
    <>
      <NavLinks />
      <div className="h-4 w-px bg-border" />
      <CommandMenu />
    </>
  );
}
