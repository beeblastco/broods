import type { Id } from "@broods/convex/_generated/dataModel";

export interface ProjectOrgGate {
  show: "page" | "refused" | "wait";
  switchTo: Id<"orgs"> | null;
}

/** What the project layout shows, and the org it moves the active org to, for a loaded project. */
export function projectOrgGate({
  activeOrg,
  landed,
  projectOrg,
  refused,
}: {
  activeOrg: Id<"orgs"> | null;
  landed: boolean;
  projectOrg: Id<"orgs">;
  refused: Id<"orgs"> | null;
}): ProjectOrgGate {
  if (refused === projectOrg) return { show: "refused", switchTo: null };
  const switchTo = projectOrg === activeOrg ? null : projectOrg;

  return { show: switchTo && !landed ? "wait" : "page", switchTo: switchTo };
}
