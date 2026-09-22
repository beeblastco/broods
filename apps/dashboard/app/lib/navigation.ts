/**
 * The project's sections, in header order. The nav links, the palette's "Go to"
 * rows and the `[` / `]` shortcuts all walk this list, so a new section shows up
 * in all three at once.
 */

export interface NavItem {
  /** What the palette matches on beyond the label. */
  keywords: readonly string[];
  label: string;
  /** Appended to `/{projectId}`; the architecture canvas is the empty one. */
  segment: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    keywords: ["canvas", "nodes", "agents", "graph", "architecture"],
    label: "Architecture",
    segment: "",
  },
  {
    keywords: ["observability", "traces", "logs", "usage", "tokens", "billing"],
    label: "Dashboard",
    segment: "/dashboard",
  },
  {
    keywords: ["cron", "crons", "schedule", "jobs"],
    label: "Scheduler",
    segment: "/scheduler",
  },
  {
    keywords: ["sandbox", "machines", "snapshots", "instances", "terminal"],
    label: "Sandbox",
    segment: "/sandbox",
  },
  {
    keywords: ["env", "variables", "webhooks", "keys", "policies", "settings"],
    label: "Settings",
    segment: "/settings",
  },
];

/** The section a pathname is in, or the architecture canvas when none matches. */
export function activeNavItem(pathname: string, projectId: string): NavItem {
  const match = NAV_ITEMS.find(
    (item) =>
      item.segment !== "" &&
      pathname.startsWith(`/${projectId}${item.segment}`),
  );

  return match ?? NAV_ITEMS[0];
}

/** A section's href, carrying the stage param so the next page does not refetch under a new key. */
export function navHref(
  projectId: string,
  segment: string,
  stageId: string | null,
): string {
  return `/${projectId}${segment}${stageId ? `?stage=${stageId}` : ""}`;
}

/** The section `offset` steps away, wrapping at both ends. */
export function stepNavItem(current: NavItem, offset: number): NavItem {
  const index = NAV_ITEMS.indexOf(current);
  const next = (index + offset + NAV_ITEMS.length) % NAV_ITEMS.length;

  return NAV_ITEMS[next];
}
