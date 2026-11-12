import { DASHBOARD_PANELS } from "@/app/(main)/[projectId]/dashboard/panels";
import {
  PROJECT_SECTIONS,
  projectSection,
} from "@/app/(main)/[projectId]/sections";
import { inBackground } from "@/app/lib/prefetch";
import { SETTINGS_PANELS } from "@/app/(main)/[projectId]/settings/panels";
import { ORG_PANELS } from "@/app/(main)/settings/org/panels";

type TabPanels = Partial<Record<string, () => Promise<unknown>>>;

const TAB_PANELS: Partial<Record<string, TabPanels>> = {
  "/dashboard": DASHBOARD_PANELS,
  "/settings": SETTINGS_PANELS,
  "/settings/org": ORG_PANELS,
};

export function isPlainPress(
  event: Pick<
    MouseEvent,
    "altKey" | "button" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** True when `href` is a page the open route already renders: no server is asked for it. */
export function isShallowRoute(pathname: string, href: string): boolean {
  const target = new URL(href, "http://localhost").pathname;
  if (target === pathname) return true;

  return (
    projectSection(pathname) !== null &&
    projectSection(target) !== null &&
    target.split("/").find(Boolean) === pathname.split("/").find(Boolean)
  );
}

/** Downloads every page and tab of a project, so the first click on each finds its chunk. */
export async function warmProject(signal: AbortSignal): Promise<void> {
  const loaders = [PROJECT_SECTIONS, DASHBOARD_PANELS, SETTINGS_PANELS].flatMap(
    (chunks): Array<(() => Promise<unknown>) | undefined> =>
      Object.values(chunks),
  );
  // One chunk at a time, each behind the open page's own work, so warming slows no render.
  for (const load of loaders) {
    await new Promise<void>((resolve) => inBackground(resolve));
    if (signal.aborted) return;
    // A failed warm-up stays quiet; the page's own load surfaces it.
    await load?.().catch((): void => {});
  }
}

export function sectionLoader(
  href: string,
): (() => Promise<unknown>) | undefined {
  const section = projectSection(new URL(href, "http://localhost").pathname);

  return section === null ? undefined : PROJECT_SECTIONS[section];
}

export function tabPanelLoader(
  href: string,
): (() => Promise<unknown>) | undefined {
  const url = new URL(href, "http://localhost");
  const panels =
    TAB_PANELS[url.pathname] ??
    TAB_PANELS[url.pathname.replace(/^\/[^/]+/, "")];

  return panels?.[url.searchParams.get("tab") ?? ""];
}
