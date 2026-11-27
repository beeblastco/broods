import type { ProjectSection } from "./sections";

const SECTION_TITLES: Record<ProjectSection, string> = {
  "": "Architecture",
  dashboard: "Dashboard",
  scheduler: "Scheduler",
  sandbox: "Sandbox",
  settings: "Settings",
};

/** The tab title of a project section, or null when the segment names none. */
export function sectionTitle(section: string): string | null {
  return Object.hasOwn(SECTION_TITLES, section)
    ? `${SECTION_TITLES[section as ProjectSection]} · Broods`
    : null;
}
