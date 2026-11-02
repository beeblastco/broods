/**
 * What a link can start before it is followed: whether a press is the plain
 * left press that navigates at once, and the chunk of the tab it opens.
 */
import { DASHBOARD_PANELS } from "@/app/(main)/[projectId]/dashboard/panels";
import { SETTINGS_PANELS } from "@/app/(main)/[projectId]/settings/panels";
import { ORG_PANELS } from "@/app/(main)/settings/org/panels";

type TabPanels = Partial<Record<string, () => Promise<unknown>>>;

// The tabs a page loads in a chunk of its own, by section: account sections by
// their path, project sections by the path past the project id.
const TAB_PANELS: Partial<Record<string, TabPanels>> = {
  "/dashboard": DASHBOARD_PANELS,
  "/settings": SETTINGS_PANELS,
  "/settings/org": ORG_PANELS,
};

/** A left press with no modifier; modified and middle clicks keep the browser's own behaviour. */
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

/** The loader of the split-out panel `href` opens, or undefined when its tab ships with the page. */
export function tabPanelLoader(
  href: string,
): (() => Promise<unknown>) | undefined {
  const url = new URL(href, "http://localhost");
  const panels =
    TAB_PANELS[url.pathname] ??
    TAB_PANELS[url.pathname.replace(/^\/[^/]+/, "")];

  return panels?.[url.searchParams.get("tab") ?? ""];
}
