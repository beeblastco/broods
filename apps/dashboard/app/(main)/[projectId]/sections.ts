// The pages of a project, each its own chunk. The route renders them via next/dynamic; a
// link calls the same loader on hover or focus, so the chunk is on its way before a click.
import type { Canvas } from "@/app/components/canvas/Canvas";
import { CONVEX_ID_SHAPE } from "@/app/lib/urlState";
import type { DashboardPage } from "./dashboard/DashboardPage";
import type { SandboxPage } from "./sandbox/SandboxPage";
import type { CronsPage } from "./scheduler/CronsPage";
import type { SettingsPage } from "./settings/SettingsPage";

export type ProjectSection = keyof typeof PROJECT_SECTIONS;

export const loadCanvas = (): Promise<typeof Canvas> =>
  import("@/app/components/canvas/Canvas").then((mod) => mod.Canvas);

export const loadDashboardPage = (): Promise<typeof DashboardPage> =>
  import("./dashboard/DashboardPage").then((mod) => mod.DashboardPage);

export const loadCronsPage = (): Promise<typeof CronsPage> =>
  import("./scheduler/CronsPage").then((mod) => mod.CronsPage);

export const loadSandboxPage = (): Promise<typeof SandboxPage> =>
  import("./sandbox/SandboxPage").then((mod) => mod.SandboxPage);

export const loadSettingsPage = (): Promise<typeof SettingsPage> =>
  import("./settings/SettingsPage").then((mod) => mod.SettingsPage);

// Keyed by the path segment after the project id; the canvas has none.
export const PROJECT_SECTIONS = {
  "": loadCanvas,
  dashboard: loadDashboardPage,
  scheduler: loadCronsPage,
  sandbox: loadSandboxPage,
  settings: loadSettingsPage,
};

/** The section a project path opens, or null when the path names none. */
export function projectSection(pathname: string): ProjectSection | null {
  const [project = "", section = "", ...rest] = pathname
    .split("/")
    .filter(Boolean);
  const known =
    CONVEX_ID_SHAPE.test(project) &&
    rest.length === 0 &&
    Object.hasOwn(PROJECT_SECTIONS, section);
  if (!known) return null;

  return section as ProjectSection;
}
