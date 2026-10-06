"use client";

/**
 * The signed-in sidebar, under the header: the current scope's sections, the
 * open section's tabs, and the account at the foot. Inside a project it walks
 * the project's sections, everywhere else the account's. Collapsed, it is an
 * icon rail that opens over the page while the pointer is on it.
 */
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

export function AppSidebar(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setOpenMobile, toggleSidebar } = useSidebar();
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
    <Sidebar collapsible="icon" className="top-(--header-height) h-auto">
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {items.map((item) => {
              const isActive = item === active;

              return (
                <SidebarMenuItem key={item.segment}>
                  <SidebarMenuButton
                    isActive={isActive && item.tabs.length === 0}
                    // The whole route, on viewport entry, except the page we
                    // are on. The default prefetch stops at loading.tsx and
                    // expires at once, so a click still fetched the tree, then
                    // its chunks, then data: three trips in a row.
                    render={
                      <Link
                        href={itemHref(item)}
                        prefetch={!isActive}
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
                      {item.tabs.map((tab) => (
                        <SidebarMenuSubItem key={tab.id}>
                          <SidebarMenuSubButton
                            isActive={tab.id === activeTab.id}
                            variant={tab.danger ? "destructive" : "default"}
                            render={
                              <Link
                                href={tabHref(
                                  `${base}${item.segment}`,
                                  tab.id,
                                  searchParams.toString(),
                                )}
                                draggable={false}
                              />
                            }
                          >
                            <span>{tab.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
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
