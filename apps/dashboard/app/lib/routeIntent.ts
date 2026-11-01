import { DASHBOARD_PANELS } from "@/app/(main)/[projectId]/dashboard/panels";
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

export function tabPanelLoader(
  href: string,
): (() => Promise<unknown>) | undefined {
  const url = new URL(href, "http://localhost");
  const panels =
    TAB_PANELS[url.pathname] ??
    TAB_PANELS[url.pathname.replace(/^\/[^/]+/, "")];

  return panels?.[url.searchParams.get("tab") ?? ""];
}
