"use client";

/**
 * The signed-in sidebar, under the header: the current scope's sections, the
 * open section's tabs, and the account at the foot. Inside a project it walks
 * the project's sections, everywhere else the account's. Collapsed, it is an
 * icon rail that opens over the page while the pointer is on it.
 */
import { DASHBOARD_PANELS } from "@/app/(main)/[projectId]/dashboard/panels";
import { SETTINGS_PANELS } from "@/app/(main)/[projectId]/settings/panels";
import { ORG_PANELS } from "@/app/(main)/settings/org/panels";
import { useShortcut } from "@/app/components/ShortcutProvider";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/app/components/ui/sidebar";
import { UserMenu } from "@/app/components/UserMenu";
import { useHydrated } from "@/app/hooks/useHydrated";
import {
  ACCOUNT_NAV_ITEMS,
  activeNavItem,
  NAV_ITEMS,
  type NavItem,
  navHref,
  pickTab,
  stepNavItem,
  tabHref,
} from "@/app/lib/navigation";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import { cn } from "@/app/lib/utils";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useEffect } from "react";

// The tabs a page loads in a chunk of its own, by section. Intent to open one
// (hover, focus, press) starts its chunk, which lands early enough to hide the
// fetch; nothing is fetched for a tab nobody reaches for.
const TAB_PANELS: Partial<
  Record<string, Partial<Record<string, () => Promise<unknown>>>>
> = {
  "/dashboard": DASHBOARD_PANELS,
  "/settings": SETTINGS_PANELS,
  "/settings/org": ORG_PANELS,
};

export function AppSidebar(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setOpenMobile, toggleSidebar } = useSidebar();
  const hydrated = useHydrated();
  const projectId = params.projectId;
  const items = projectId ? NAV_ITEMS : ACCOUNT_NAV_ITEMS;
  const base = projectId ? `/${projectId}` : "";
  const active = activeNavItem(items, pathname, base);
  const activeTab =
    active.tabs.length > 0
      ? pickTab(active.tabs, searchParams.get("tab"))
      : null;
  const stageParam = searchParams.get("stage");

  // Only the URL's own `?stage=`, never the derived default, so each href is
  // stable from the first render and no prefetch wave is thrown away.
  const itemHref = (item: NavItem): string =>
    projectId ? navHref(projectId, item.segment, stageParam) : item.segment;
  // Home only redirects to a project, so its links are never walked.
  const prefetchRoute = (item: NavItem, isActive: boolean): void => {
    if (!isActive && pathname !== "/") {
      router.prefetch(itemHref(item), FULL_ROUTE_PREFETCH);
    }
  };
  // Navigate on press, not on release: a click spends about 100 ms between
  // the two. Only a plain left press; modified and middle clicks keep the
  // browser's own behaviour, and a keyboard Enter still goes through onClick.
  const isPlainPress = (event: React.MouseEvent): boolean =>
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey;

  useShortcut("nav.prev", () =>
    router.push(itemHref(stepNavItem(items, active, -1))),
  );
  useShortcut("nav.next", () =>
    router.push(itemHref(stepNavItem(items, active, 1))),
  );
  useShortcut("sidebar.toggle", toggleSidebar);

  // On a phone the sidebar is a sheet over the page: close it once a link,
  // here or in the account menu, has moved to another page or tab.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, searchParams, setOpenMobile]);

  return (
    <Sidebar
      collapsible="icon"
      className="top-(--header-height) h-auto"
      data-hydrated={hydrated ? "true" : undefined}
    >
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {items.map((item) => {
              const isActive = item === active;

              return (
                <SidebarMenuItem key={item.segment}>
                  <SidebarMenuButton
                    isActive={isActive && item.tabs.length === 0}
                    // The whole route, on intent (hover, focus), except
                    // the page we are on. The default prefetch stops at
                    // loading.tsx and expires at once, so a click still fetched
                    // the tree, then its chunks, then data: three trips in a
                    // row. Prefetching on viewport entry instead loaded every
                    // route's chunks and data right after each cold load.
                    render={
                      <Link
                        href={itemHref(item)}
                        prefetch={false}
                        onMouseEnter={() => prefetchRoute(item, isActive)}
                        onFocus={() => prefetchRoute(item, isActive)}
                        onMouseDown={(event) => {
                          if (isPlainPress(event) && !isActive) {
                            router.push(itemHref(item));
                          }
                        }}
                        onClick={(event) => {
                          // Pressed already navigated; skip Link's own push.
                          // The active item has no press push, so its click
                          // still resets the section to its default tab.
                          if (
                            event.detail > 0 &&
                            isPlainPress(event) &&
                            !isActive
                          ) {
                            event.preventDefault();
                          }
                        }}
                        draggable={false}
                      />
                    }
                  >
                    <item.icon />
                    <span>{item.label}</span>
                    {item.tabs.length > 0 && (
                      <ChevronRight
                        className={cn(
                          "ml-auto transition-transform",
                          isActive && "rotate-90",
                        )}
                      />
                    )}
                  </SidebarMenuButton>
                  {isActive && activeTab && (
                    <SidebarMenuSub>
                      {item.tabs.map((tab) => {
                        const load = TAB_PANELS[item.segment]?.[tab.id];
                        // A failed warm-up stays quiet; the click's load surfaces it.
                        const warm = load
                          ? (): void => void load().catch((): void => {})
                          : undefined;

                        return (
                          <SidebarMenuSubItem key={tab.id}>
                            <SidebarMenuSubButton
                              isActive={tab.id === activeTab.id}
                              variant={tab.danger ? "destructive" : "default"}
                              onMouseEnter={warm}
                              onFocus={warm}
                              onPointerDown={warm}
                              render={
                                <Link
                                  href={tabHref(
                                    `${base}${item.segment}`,
                                    tab.id,
                                    searchParams.toString(),
                                  )}
                                  prefetch={false}
                                  draggable={false}
                                />
                              }
                            >
                              <span>{tab.label}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
