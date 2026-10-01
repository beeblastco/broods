"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/app/components/ui/sidebar";
import { NAV_ITEMS } from "@/app/lib/navigation";
import { MonitoringPanel } from "../(main)/[projectId]/dashboard/components/MonitoringPanel";
import { TracingPanel } from "../(main)/[projectId]/dashboard/components/TracingPanel";

/**
 * The dashboard page around the real Monitoring and Tracing panels: the app
 * shell's header, its collapsed sidebar rail, and the full-bleed content
 * column, with the classes those layouts use. A spec answers the panels'
 * observability socket, so View trace runs the real navigation and focus
 * scroll with no backend behind it.
 */
export function ObservabilityPageStandIn({
  tab,
}: {
  tab: "monitoring" | "tracing";
}): React.JSX.Element {
  return (
    <SidebarProvider defaultOpen={false} className="h-screen flex-col">
      <div className="h-(--header-height) shrink-0 border-b border-border" />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsible="icon" className="top-(--header-height) h-auto">
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.segment}>
                    <SidebarMenuButton>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="min-w-0 overflow-hidden">
          <div className="flex h-full flex-col overflow-hidden">
            <h1 className="sr-only">
              {tab === "tracing" ? "Tracing" : "Monitoring"}
            </h1>
            <div className="mx-auto flex min-h-0 w-full max-w-none flex-1 flex-col">
              {tab === "tracing" ? (
                <TracingPanel
                  projectSlug="gallery"
                  stageSlug="dev"
                  apiKey="gallery-viewing-key"
                />
              ) : (
                <MonitoringPanel
                  projectSlug="gallery"
                  stageSlug="dev"
                  apiKey="gallery-viewing-key"
                />
              )}
            </div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
